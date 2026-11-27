// Entrar com Google no BFF: state/nonce/PKCE, cookie cifrado de uso único, troca do código com o
// Google, entrega só do ID token + nonce ao backend e criação da sessão pelo núcleo do login.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { loadBffConfig } from "../src/server/bff/config.mjs";
import { createMemorySessionStore } from "../src/server/bff/session-store.mjs";
import { createBff } from "../src/server/bff/manager.mjs";
import { stateCookieName } from "../src/server/bff/google-login.mjs";
import { createFakeBackend, tok } from "./helpers/fake-backend.mjs";

const ORIGIN = "http://localhost:3000";
const GOOGLE = { PRAZOAI_GOOGLE_CLIENT_ID: "123-abc.apps.googleusercontent.com", PRAZOAI_GOOGLE_CLIENT_SECRET: "segredo-do-cliente-de-teste" };
const ENV = { PRAZOAI_APP_ENV: "test", PRAZOAI_APP_ORIGIN: ORIGIN, PRAZOAI_COOKIE_INSECURE_LOCAL: "true",
  PRAZOAI_BACKEND_URL: "http://127.0.0.1:8000", ...GOOGLE };
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const ID_TOKEN = "eyJhbGciOiJSUzI1NiJ9." + "x".repeat(40) + ".assinatura";

function setup(envOver = {}) {
  let t = 1_000_000;
  const clock = { now: () => t, advance: (ms) => { t += ms; } };
  const config = loadBffConfig({ ...ENV, ...envOver });
  const store = createMemorySessionStore(config.session, clock.now);
  const backend = createFakeBackend();
  const google = { calls: [], status: 200, body: { id_token: ID_TOKEN, access_token: "ya29.x", token_type: "Bearer" } };
  const backendGoogle = { calls: [], status: 200, code: null };
  const fetchImpl = async (url, init) => {
    if (String(url) === TOKEN_URL) {
      google.calls.push({ body: new URLSearchParams(init.body), redirect: init.redirect });
      if (google.status === "network") throw new TypeError("fetch failed");
      return new Response(JSON.stringify(google.body), { status: google.status, headers: { "content-type": "application/json" } });
    }
    if (new URL(url).pathname.endsWith("/auth/google")) {
      const body = JSON.parse(init.body);
      backendGoogle.calls.push({ body, headers: init.headers });
      if (backendGoogle.status !== 200) {
        return new Response(JSON.stringify({ error: { code: backendGoogle.code ?? "invalid_google_token", message: "x" } }),
          { status: backendGoogle.status, headers: { "content-type": "application/json" } });
      }
      backend.seq += 1;
      const s = { used: new Set(), revoked: false, access: tok("a", backend.seq), refresh: tok("r", backend.seq) };
      backend.sessions.push(s);
      return new Response(JSON.stringify({ accessToken: s.access, refreshToken: s.refresh, tokenType: "Bearer", expiresIn: 900,
        user: backend.user }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return backend.fetch(url, init);
  };
  const logs = [];
  const bff = createBff({ config, store, fetchImpl, now: clock.now, logger: { info: (...a) => logs.push(JSON.stringify(a)) } });
  return { bff, store, backend, google, backendGoogle, clock, config, logs };
}

const get = (path, cookie) => new Request(`${ORIGIN}${path}`, { headers: cookie ? { cookie } : {} });
const cookiesOf = (r) => r.headers.getSetCookie();
const pair = (setCookie) => setCookie.split(";")[0];

async function startFlow(env) {
  const r = env.bff.googleStart(get("/bff/auth/google/start"));
  const url = new URL(r.headers.get("location"));
  const stateCookie = cookiesOf(r).find((c) => c.startsWith(`${stateCookieName(env.config)}=`));
  return { r, url, stateCookie, cookie: pair(stateCookie), state: url.searchParams.get("state") };
}

test("config: id e segredo juntos; endereços de teste recusados em produção", () => {
  const base = { PRAZOAI_APP_ENV: "test", PRAZOAI_APP_ORIGIN: ORIGIN, PRAZOAI_COOKIE_INSECURE_LOCAL: "true" };
  assert.equal(loadBffConfig(base).google, null);
  assert.throws(() => loadBffConfig({ ...base, PRAZOAI_GOOGLE_CLIENT_ID: GOOGLE.PRAZOAI_GOOGLE_CLIENT_ID }));
  assert.throws(() => loadBffConfig({ ...base, PRAZOAI_GOOGLE_CLIENT_SECRET: "segredo-solto" }));
  const c = loadBffConfig({ ...base, ...GOOGLE });
  assert.equal(c.google.redirectUri, `${ORIGIN}/bff/auth/google/callback`);
  assert.equal(JSON.stringify(c).includes(GOOGLE.PRAZOAI_GOOGLE_CLIENT_SECRET), false);   // segredo não enumerável
  assert.equal(c.googleClientSecret, GOOGLE.PRAZOAI_GOOGLE_CLIENT_SECRET);
  assert.doesNotThrow(() => loadBffConfig({ ...base, ...GOOGLE, PRAZOAI_GOOGLE_TOKEN_URL: "http://127.0.0.1:9999/token" }));
});

test("status: disponível só quando configurado", async () => {
  assert.deepEqual(await setup().bff.googleStatus().json(), { available: true });
  const off = setup({ PRAZOAI_GOOGLE_CLIENT_ID: "", PRAZOAI_GOOGLE_CLIENT_SECRET: "" });
  assert.deepEqual(await off.bff.googleStatus().json(), { available: false });
  const r = off.bff.googleStart(get("/bff/auth/google/start"));
  assert.equal(new URL(r.headers.get("location")).search, "?google=indisponivel");
});

test("início: redireciona ao Google com PKCE S256, state e nonce; cookie cifrado, HttpOnly, Lax e curto", async () => {
  const env = setup();
  const { r, url, stateCookie } = await startFlow(env);
  assert.equal(r.status, 303);
  assert.equal(url.origin + url.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
  const p = url.searchParams;
  assert.equal(p.get("client_id"), GOOGLE.PRAZOAI_GOOGLE_CLIENT_ID);
  assert.equal(p.get("redirect_uri"), `${ORIGIN}/bff/auth/google/callback`);
  assert.equal(p.get("response_type"), "code");
  assert.equal(p.get("scope"), "openid email profile");
  assert.equal(p.get("code_challenge_method"), "S256");
  assert.ok(p.get("state").length >= 40 && p.get("nonce").length >= 40 && p.get("code_challenge").length >= 40);
  assert.match(stateCookie, /HttpOnly/);
  assert.match(stateCookie, /SameSite=Lax/);
  assert.match(stateCookie, /Max-Age=600/);
  // O cookie não revela state, nonce nem verificador em texto claro.
  for (const k of ["state", "nonce"]) assert.equal(stateCookie.includes(p.get(k)), false);
  assert.equal(r.headers.get("cache-control"), "no-store, private");
});

test("retorno: troca o código com PKCE, entrega só ID token + nonce ao backend e cria a sessão", async () => {
  const env = setup();
  const { url, cookie, state } = await startFlow(env);
  const r = await env.bff.googleCallback(get(`/bff/auth/google/callback?state=${state}&code=codigo-do-google`, cookie));
  assert.equal(r.status, 200);
  assert.match(await r.text(), /url=\/app/);
  const set = cookiesOf(r);
  const session = set.find((c) => c.startsWith(`${env.config.cookie.name}_`));
  assert.ok(session && /HttpOnly/.test(session) && /SameSite=Strict/.test(session));
  assert.ok(set.some((c) => c.startsWith(`${stateCookieName(env.config)}=;`) && /Max-Age=0/.test(c)));   // uso único
  // Troca do código: client secret + verificador cujo hash é o challenge enviado.
  const sent = env.google.calls[0].body;
  assert.equal(sent.get("grant_type"), "authorization_code");
  assert.equal(sent.get("code"), "codigo-do-google");
  assert.equal(sent.get("client_secret"), GOOGLE.PRAZOAI_GOOGLE_CLIENT_SECRET);
  assert.equal(createHash("sha256").update(sent.get("code_verifier")).digest("base64url"), url.searchParams.get("code_challenge"));
  assert.equal(env.google.calls[0].redirect, "error");
  // Backend recebe SÓ o ID token e o MESMO nonce enviado ao Google.
  assert.deepEqual(env.backendGoogle.calls[0].body, { idToken: ID_TOKEN, nonce: url.searchParams.get("nonce") });
  // A sessão funciona como a do login por senha.
  const me = await env.bff.session(new Request(`${ORIGIN}/bff/session`, { headers: { cookie: pair(session), "x-prazoai-csrf": "1" } }));
  assert.equal(me.status, 200);
  assert.equal((await me.json()).user.email, "ana@exemplo.com");
  // Nada sensível em log.
  const text = env.logs.join("\n");
  for (const s of [ID_TOKEN, GOOGLE.PRAZOAI_GOOGLE_CLIENT_SECRET, "codigo-do-google", state]) assert.equal(text.includes(s), false);
});

for (const [name, mutate, reason] of [
  ["state diferente", (f) => ({ q: `state=${"a".repeat(f.state.length)}&code=c`, cookie: f.cookie }), "expirado"],
  ["sem cookie", (f) => ({ q: `state=${f.state}&code=c`, cookie: null }), "expirado"],
  ["cookie adulterado", (f) => ({ q: `state=${f.state}&code=c`, cookie: f.cookie.slice(0, -4) + "AAAA" }), "expirado"],
  ["sem código", (f) => ({ q: `state=${f.state}`, cookie: f.cookie }), "expirado"],
  ["pessoa cancelou", (f) => ({ q: `error=access_denied&state=${f.state}`, cookie: f.cookie }), "cancelado"],
]) {
  test(`retorno recusado (${name}): sem troca de código, sem sessão`, async () => {
    const env = setup();
    const f = await startFlow(env);
    const { q, cookie } = mutate(f);
    const r = await env.bff.googleCallback(get(`/bff/auth/google/callback?${q}`, cookie));
    assert.equal(r.status, 303);
    assert.equal(r.headers.get("location"), `${ORIGIN}/login?google=${reason}`);
    assert.equal(env.google.calls.length, 0);
    assert.equal(env.backendGoogle.calls.length, 0);
    assert.ok(!cookiesOf(r).some((c) => c.startsWith(`${env.config.cookie.name}_`) && !/Max-Age=0/.test(c)));
  });
}

test("retorno expirado depois de 10 minutos", async () => {
  const env = setup();
  const f = await startFlow(env);
  env.clock.advance(10 * 60 * 1000 + 1);
  const r = await env.bff.googleCallback(get(`/bff/auth/google/callback?state=${f.state}&code=c`, f.cookie));
  assert.equal(r.headers.get("location"), `${ORIGIN}/login?google=expirado`);
  assert.equal(env.google.calls.length, 0);
});

test("cookie de outra tentativa não serve (state amarrado ao cookie)", async () => {
  const env = setup();
  const a = await startFlow(env);
  const b = await startFlow(env);
  const r = await env.bff.googleCallback(get(`/bff/auth/google/callback?state=${a.state}&code=c`, b.cookie));
  assert.equal(r.headers.get("location"), `${ORIGIN}/login?google=expirado`);
});

for (const [name, prep, reason] of [
  ["Google recusa o código", (e) => { e.google.status = 400; e.google.body = { error: "invalid_grant" }; }, "falhou"],
  ["Google fora do ar", (e) => { e.google.status = "network"; }, "indisponivel"],
  ["resposta sem id_token", (e) => { e.google.body = { access_token: "x" }; }, "falhou"],
  ["backend recusa o token", (e) => { e.backendGoogle.status = 401; }, "conta"],
  ["backend limita", (e) => { e.backendGoogle.status = 429; e.backendGoogle.code = "rate_limited"; }, "limite"],
  ["backend sem Google configurado", (e) => { e.backendGoogle.status = 503; e.backendGoogle.code = "google_login_unavailable"; }, "indisponivel"],
]) {
  test(`falha controlada (${name}) → /login?google=${reason}, sem sessão`, async () => {
    const env = setup();
    prep(env);
    const f = await startFlow(env);
    const r = await env.bff.googleCallback(get(`/bff/auth/google/callback?state=${f.state}&code=c`, f.cookie));
    assert.equal(r.status, 303);
    assert.equal(r.headers.get("location"), `${ORIGIN}/login?google=${reason}`);
    assert.ok(!cookiesOf(r).some((c) => c.startsWith(`${env.config.cookie.name}_`)));
  });
}

test("login por senha continua igual depois da reorganização do núcleo", async () => {
  const env = setup();
  const r = await env.bff.login(new Request(`${ORIGIN}/bff/auth/login`, { method: "POST",
    headers: { "x-prazoai-csrf": "1", origin: ORIGIN, "content-type": "application/json" },
    body: JSON.stringify({ email: "ana@exemplo.com", password: "Senha-123" }) }));
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { user: env.backend.user });
});

test("produção: cookie __Host- com Secure, retorno em HTTPS e endereços de teste recusados", () => {
  const HOSTED = {
    PRAZOAI_APP_ENV: "production", PRAZOAI_APP_ORIGIN: "https://app.exemplo.com",
    PRAZOAI_BACKEND_URL: "https://api.exemplo.com", PRAZOAI_PROXY_SECRET: "p".repeat(40),
    PRAZOAI_TRUSTED_CLIENT_IP_HEADER: "x-real-ip", PRAZOAI_BFF_SESSION_STORE: "postgres",
    PRAZOAI_BFF_DATABASE_URL: "postgresql://bff:SENHA-FICTICIA@db.exemplo.com:5432/prazoai?sslmode=verify-full",
    PRAZOAI_BFF_SESSION_KEY: Buffer.from(Array.from({ length: 32 }, (_, i) => i * 7 + 1)).toString("base64url"),
    ...GOOGLE,
  };
  const config = loadBffConfig(HOSTED);
  assert.equal(config.google.redirectUri, "https://app.exemplo.com/bff/auth/google/callback");
  assert.equal(config.google.authorizeUrl, "https://accounts.google.com/o/oauth2/v2/auth");
  assert.equal(config.google.tokenUrl, TOKEN_URL);
  assert.equal(stateCookieName(config), "__Host-prazoai_gauth");
  const store = createMemorySessionStore(config.session, () => 0);
  const r = createBff({ config, store, fetchImpl: async () => { throw new Error("sem rede"); }, now: () => 0,
    logger: { info() {} } }).googleStart(new Request("https://app.exemplo.com/bff/auth/google/start"));
  const c = r.headers.getSetCookie().find((x) => x.startsWith("__Host-prazoai_gauth="));
  assert.ok(c && /; Secure/.test(c) && /Path=\//.test(c) && !/Domain=/i.test(c));
  for (const k of ["PRAZOAI_GOOGLE_AUTHORIZE_URL", "PRAZOAI_GOOGLE_TOKEN_URL"]) {
    assert.throws(() => loadBffConfig({ ...HOSTED, [k]: "https://falso.exemplo.com/x" }));
  }
});
