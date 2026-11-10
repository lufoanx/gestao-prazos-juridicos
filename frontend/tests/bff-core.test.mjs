// Etapa 6.1 — núcleo do BFF com DUBLÊ do backend (testes unitários, não integração real).
import test from "node:test";
import assert from "node:assert/strict";
import { loadBffConfig } from "../src/server/bff/config.mjs";
import { createMemorySessionStore, SessionCapacityError } from "../src/server/bff/session-store.mjs";
import { createBff } from "../src/server/bff/manager.mjs";
import { segmentsToPath, matchAllowlist } from "../src/server/bff/allowlist.mjs";
import { createFakeBackend, deferred } from "./helpers/fake-backend.mjs";

const ORIGIN = "http://localhost:3000";
const ENV = { PRAZOAI_APP_ENV: "test", PRAZOAI_APP_ORIGIN: ORIGIN, PRAZOAI_COOKIE_INSECURE_LOCAL: "true",
  PRAZOAI_BACKEND_URL: "http://127.0.0.1:8000" };

function setup(envOver = {}) {
  let t = 1_000_000;
  const clock = { now: () => t, advance: (ms) => { t += ms; } };
  const config = loadBffConfig({ ...ENV, ...envOver });
  const store = createMemorySessionStore(config.session, clock.now);
  const backend = createFakeBackend();
  const logs = [];
  const bff = createBff({ config, store, fetchImpl: backend.fetch, now: clock.now,
    logger: { info: (...a) => logs.push(JSON.stringify(a)) } });
  return { bff, store, backend, clock, config, logs };
}

function req(method, path, { body, cookie, origin = ORIGIN, csrf = true, headers = {} } = {}) {
  const h = new Headers(headers);
  if (csrf) h.set("x-prazoai-csrf", "1");
  if (origin) h.set("origin", origin);
  if (cookie) h.set("cookie", cookie);
  if (body !== undefined) h.set("content-type", "application/json");
  return new Request(`${ORIGIN}${path}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
}

async function login(env) {
  const r = await env.bff.login(req("POST", "/bff/auth/login", { body: { email: "ana@exemplo.com", password: "Senha-123" } }));
  const setCookie = r.headers.get("set-cookie");
  return { r, cookie: setCookie.split(";")[0], setCookie };
}

const hasToken = (text) => /\b[ar]\d+-x{24}/.test(text);

// ---------------------------------------------------------------- configuração
test("config: segurança dos cookies independe de NODE_ENV e de cabeçalhos", () => {
  assert.throws(() => loadBffConfig({ ...ENV, PRAZOAI_COOKIE_INSECURE_LOCAL: undefined }));
  assert.throws(() => loadBffConfig({ ...ENV, PRAZOAI_APP_ENV: "production" }));
  assert.throws(() => loadBffConfig({ ...ENV, PRAZOAI_APP_ORIGIN: "http://app.exemplo.com" }));
  assert.throws(() => loadBffConfig({ ...ENV, PRAZOAI_APP_ORIGIN: "https://app.exemplo.com" })); // flag local + https
  const prod = loadBffConfig({ PRAZOAI_APP_ENV: "production", PRAZOAI_APP_ORIGIN: "https://app.exemplo.com", NODE_ENV: "development" });
  assert.equal(prod.cookie.name, "__Host-prazoai_sid");
  assert.equal(prod.cookie.secure, true);
  const local = loadBffConfig({ ...ENV, NODE_ENV: "production" });            // next start em teste
  assert.equal(local.cookie.secure, false);
  assert.equal(local.cookie.name, "prazoai_sid");
  assert.throws(() => loadBffConfig({ ...ENV, PRAZOAI_APP_ORIGIN: undefined }));
  assert.throws(() => loadBffConfig({ ...ENV, PRAZOAI_BACKEND_URL: "http://user:pw@127.0.0.1:8000" }));
});

test("config: IP do cliente só por cabeçalho de infraestrutura explícito e com segredo", () => {
  assert.throws(() => loadBffConfig({ ...ENV, PRAZOAI_TRUSTED_CLIENT_IP_HEADER: "x-real-ip" }));
  assert.throws(() => loadBffConfig({ ...ENV, PRAZOAI_PROXY_SECRET: "s".repeat(40), PRAZOAI_TRUSTED_CLIENT_IP_HEADER: "x-forwarded-for" }));
  assert.throws(() => loadBffConfig({ ...ENV, PRAZOAI_PROXY_SECRET: "curto" }));
  const ok = loadBffConfig({ ...ENV, PRAZOAI_PROXY_SECRET: "s".repeat(40), PRAZOAI_TRUSTED_CLIENT_IP_HEADER: "x-real-ip" });
  assert.equal(ok.clientIpHeader, "x-real-ip");
});

// ---------------------------------------------------------------- armazenamento
test("store: expiração por inatividade e idade, limpeza e capacidade sem derrubar sessões", () => {
  let t = 0;
  const store = createMemorySessionStore({ maxSessions: 2, idleSeconds: 60, maxAgeSeconds: 300, sweepIntervalSeconds: 10 }, () => t);
  const a = store.create({ userId: "u", accessToken: "a", refreshToken: "r", accessExpiresAt: 0 });
  store.create({ userId: "u", accessToken: "a", refreshToken: "r", accessExpiresAt: 0 });
  assert.throws(() => store.create({ userId: "u", accessToken: "a", refreshToken: "r", accessExpiresAt: 0 }), SessionCapacityError);
  t += 59_000;
  assert.ok(store.get(a));                                        // ativa renova a inatividade
  t += 59_000;
  store.create({ userId: "u", accessToken: "a", refreshToken: "r", accessExpiresAt: 0 }); // a outra expirou → liberou
  assert.equal(store.size, 2);
  t += 300_000;
  assert.equal(store.get(a), null);                               // idade máxima
  assert.equal(store.sweep(true) >= 0, true);
  assert.equal(store.size, 0);
});

test("store: remoção apaga os tokens e troca condicional por geração", () => {
  const store = createMemorySessionStore({ maxSessions: 5, idleSeconds: 60, maxAgeSeconds: 300, sweepIntervalSeconds: 10 });
  const id = store.create({ userId: "u", accessToken: "a1", refreshToken: "r1", accessExpiresAt: 0 });
  const s = store.get(id);
  assert.equal(store.updateTokens(id, s.generation + 1, { accessToken: "x", refreshToken: "y", accessExpiresAt: 0 }), false);
  assert.equal(store.updateTokens(id, s.generation, { accessToken: "a2", refreshToken: "r2", accessExpiresAt: 0 }), true);
  assert.deepEqual(store.delete(id), { accessToken: "a2" });
  assert.equal(s.accessToken, "");
  assert.equal(s.refreshToken, "");
  assert.equal(store.updateTokens(id, s.generation, { accessToken: "x", refreshToken: "y", accessExpiresAt: 0 }), false);
  assert.match(id, /^[A-Za-z0-9_-]{43}$/);
});

// ---------------------------------------------------------------- login / sessão / logout
test("login: cookie opaco HttpOnly; nenhum token no JSON, cabeçalhos ou logs", async () => {
  const env = setup();
  const { r, setCookie } = await login(env);
  assert.equal(r.status, 200);
  const text = await r.text();
  assert.deepEqual(JSON.parse(text), { user: env.backend.user });
  assert.equal(hasToken(text), false);
  const cookies = r.headers.getSetCookie();
  assert.match(cookies[0], /^prazoai_sid_[a-z0-9]{10}=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Strict; Max-Age=\d+$/);
  assert.match(cookies[1], /^prazoai_bid=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Strict; Max-Age=\d+$/);
  for (const [, v] of r.headers) assert.equal(hasToken(v), false);
  assert.equal(r.headers.get("cache-control"), "no-store, private");
  assert.equal(env.logs.some(hasToken), false);
  assert.equal(env.logs.some((l) => l.includes(setCookie.split("=")[1].split(";")[0])), false);
});

test("login: erros preservados (401, 429 com Retry-After, indisponível, timeout)", async () => {
  const env = setup();
  env.backend.loginStatus = 401;
  const body = { email: "a@b.com", password: "x" };
  let r = await env.bff.login(req("POST", "/bff/auth/login", { body }));
  assert.equal(r.status, 401);
  env.backend.loginStatus = 429;
  r = await env.bff.login(req("POST", "/bff/auth/login", { body }));
  assert.equal(r.status, 429); assert.equal(r.headers.get("retry-after"), "300");
  env.backend.loginStatus = 200;
  env.backend.failNext = "refused";
  r = await env.bff.login(req("POST", "/bff/auth/login", { body }));
  assert.equal(r.status, 503);
  env.backend.failNext = "timeout";
  r = await env.bff.login(req("POST", "/bff/auth/login", { body }));
  assert.equal(r.status, 504);
  assert.equal(env.store.size, 0);
});

test("novo login encerra a sessão anterior do navegador (troca de usuário)", async () => {
  const env = setup();
  const first = await login(env);
  const oldAccess = env.backend.current.access;
  const r = await env.bff.login(req("POST", "/bff/auth/login", { cookie: first.cookie, body: { email: "b@b.com", password: "x" } }));
  assert.equal(r.status, 200);
  assert.ok(env.backend.calls.some((c) => c.path === "/auth/logout" && c.headers.authorization === `Bearer ${oldAccess}`));
  assert.equal(env.store.size, 1);
  const stale = await env.bff.session(req("GET", "/bff/session", { cookie: first.cookie }));
  assert.deepEqual(await stale.json(), { authenticated: false });
});

test("sessão: anônima, autenticada e renovação antes do envio", async () => {
  const env = setup();
  assert.deepEqual(await (await env.bff.session(req("GET", "/bff/session"))).json(), { authenticated: false });
  const { cookie } = await login(env);
  let r = await env.bff.session(req("GET", "/bff/session", { cookie }));
  assert.deepEqual(await r.json(), { authenticated: true, user: env.backend.user });
  env.clock.advance(880_000);                                      // dentro da margem de 30 s
  r = await env.bff.session(req("GET", "/bff/session", { cookie }));
  assert.equal(r.status, 200);
  assert.equal(env.backend.calls.filter((c) => c.path === "/auth/refresh").length, 1);
  assert.equal(r.headers.get("set-cookie"), null);                 // respostas comuns não emitem cookie
});

test("logout: invalida localmente primeiro, revoga no backend, limpa cookie, idempotente", async () => {
  const env = setup();
  const { cookie } = await login(env);
  const r = await env.bff.logout(req("POST", "/bff/auth/logout", { cookie }));
  assert.equal(r.status, 204);
  assert.match(r.headers.get("set-cookie"), /Max-Age=0/);
  assert.equal(env.store.size, 0);
  assert.equal(env.backend.revoked, true);
  assert.equal((await env.bff.logout(req("POST", "/bff/auth/logout", { cookie }))).status, 204);
  const after = await env.bff.proxy(req("GET", "/bff/api/users/me", { cookie }), "/users/me");
  assert.equal(after.status, 401);
});

test("logout com backend fora do ar: sessão local encerrada mesmo assim", async () => {
  const env = setup();
  const { cookie } = await login(env);
  env.backend.failNext = "refused";
  assert.equal((await env.bff.logout(req("POST", "/bff/auth/logout", { cookie }))).status, 204);
  assert.equal(env.store.size, 0);
});

// ---------------------------------------------------------------- renovação e concorrência
test("duas abas renovando ao mesmo tempo: UMA renovação, ambas usam o estado novo", async () => {
  const env = setup();
  const { cookie } = await login(env);
  env.clock.advance(890_000);
  const gate = deferred();
  env.backend.beforeRefresh = () => gate.promise;
  const tabA = env.bff.proxy(req("GET", "/bff/api/users/me", { cookie }), "/users/me");
  const tabB = env.bff.proxy(req("GET", "/bff/api/auth/me", { cookie }), "/auth/me");
  const tabC = env.bff.session(req("GET", "/bff/session", { cookie }));
  await new Promise((r) => setImmediate(r));
  gate.resolve();
  const [a, b, c] = await Promise.all([tabA, tabB, tabC]);
  assert.deepEqual([a.status, b.status, c.status], [200, 200, 200]);
  assert.equal(env.backend.calls.filter((x) => x.path === "/auth/refresh").length, 1);
  assert.equal(env.backend.revoked, false);                        // sem reutilização detectada
  const usedTokens = env.backend.calls.filter((x) => x.path !== "/auth/refresh" && x.path !== "/auth/login").map((x) => x.headers.authorization);
  assert.ok(usedTokens.slice(-3).every((t) => t === `Bearer ${env.backend.current.access}`));
});

test("logout concorrendo com renovação: a renovação não recria a sessão", async () => {
  const env = setup();
  const { cookie } = await login(env);
  env.clock.advance(890_000);
  const gate = deferred();
  env.backend.beforeRefresh = () => gate.promise;
  const pending = env.bff.proxy(req("GET", "/bff/api/users/me", { cookie }), "/users/me");
  await new Promise((r) => setImmediate(r));
  const out = await env.bff.logout(req("POST", "/bff/auth/logout", { cookie }));
  assert.equal(out.status, 204);
  gate.resolve();
  const r = await pending;
  assert.equal(r.status, 401);
  assert.equal(env.store.size, 0);
  const again = await env.bff.session(req("GET", "/bff/session", { cookie }));
  assert.deepEqual(await again.json(), { authenticated: false });
});

test("renovação rejeitada (401): sessão encerrada e cookie limpo", async () => {
  const env = setup();
  const { cookie } = await login(env);
  env.clock.advance(890_000);
  env.backend.failRefresh = "401";
  const r = await env.bff.proxy(req("GET", "/bff/api/users/me", { cookie }), "/users/me");
  assert.equal(r.status, 401);
  assert.equal((await r.json()).error.code, "session_expired");
  assert.match(r.headers.get("set-cookie"), /Max-Age=0/);
  assert.equal(env.store.size, 0);
});

test("renovação incerta (timeout/rede): sessão local invalidada, refresh antigo NÃO repetido", async () => {
  for (const kind of ["timeout", "network"]) {
    const env = setup();
    const { cookie } = await login(env);
    env.clock.advance(890_000);
    env.backend.failRefresh = kind;
    const r = await env.bff.proxy(req("GET", "/bff/api/users/me", { cookie }), "/users/me");
    assert.equal(r.status, 401);
    assert.equal((await r.json()).error.code, "session_refresh_uncertain");
    assert.equal(env.store.size, 0);
    await env.bff.proxy(req("GET", "/bff/api/users/me", { cookie }), "/users/me");
    assert.equal(env.backend.calls.filter((c) => c.path === "/auth/refresh").length, 1);
  }
});

test("backend indisponível na renovação: 503, sem logout indevido", async () => {
  for (const kind of ["refused", "500"]) {
    const env = setup();
    const { cookie } = await login(env);
    env.clock.advance(890_000);
    env.backend.failRefresh = kind;
    const r = await env.bff.proxy(req("GET", "/bff/api/users/me", { cookie }), "/users/me");
    assert.equal(r.status, 503);
    assert.equal((await r.json()).error.code, "backend_unavailable");
    assert.equal(r.headers.get("set-cookie"), null);
    assert.equal(env.store.size, 1);
    env.backend.failRefresh = null;
    assert.equal((await env.bff.proxy(req("GET", "/bff/api/users/me", { cookie }), "/users/me")).status, 200);
  }
});

// ---------------------------------------------------------------- proxy
test("proxy: 503 por indisponibilidade, 429 preservado, 5xx sem logout, 401 sem nova tentativa", async () => {
  const env = setup();
  const { cookie } = await login(env);
  const get = () => env.bff.proxy(req("GET", "/bff/api/users/me", { cookie }), "/users/me");
  env.backend.failNext = "refused";
  assert.equal((await get()).status, 503);
  env.backend.failNext = "429";
  const r429 = await get();
  assert.equal(r429.status, 429); assert.equal(r429.headers.get("retry-after"), "60");
  env.backend.failNext = "500";
  assert.equal((await get()).status, 503);
  assert.equal(env.store.size, 1);
  env.backend.revoked = true;
  const before = env.backend.calls.length;
  const r401 = await get();
  assert.equal(r401.status, 401);
  assert.equal(env.backend.calls.length - before, 1);              // nenhuma repetição
  assert.equal(env.store.size, 0);
});

test("proxy: mutação com resultado desconhecido NÃO é repetida", async () => {
  const env = setup();
  const { cookie } = await login(env);
  env.backend.failNext = "timeout";
  const r = await env.bff.proxy(req("PATCH", "/bff/api/users/me", { cookie, body: { name: "Bia" } }), "/users/me");
  assert.equal(r.status, 504);
  assert.equal((await r.json()).outcome, "unknown");
  assert.equal(env.backend.calls.filter((c) => c.method === "PATCH").length, 1);
});

test("proxy: lista explícita de rotas e métodos; caminhos suspeitos recusados", async () => {
  const env = setup();
  const { cookie } = await login(env);
  // 6.2–6.4 ampliaram a lista; rotas fora do escopo (anexos) seguem fora (404).
  assert.equal((await env.bff.proxy(req("GET", "/bff/api/attachments", { cookie }), "/attachments")).status, 404);
  assert.equal((await env.bff.proxy(req("GET", "/bff/api/offices", { cookie }), "/offices")).status, 405);
  assert.equal((await env.bff.proxy(req("DELETE", "/bff/api/users/me", { cookie }), "/users/me")).status, 405);
  assert.equal(matchAllowlist("POST", "/auth/refresh"), "not_found");          // refresh nunca exposto
  assert.equal(matchAllowlist("POST", "/auth/login"), "not_found");
  for (const bad of [["..", "users"], ["users", "..", "me"], ["%2e%2e"], [], ["http:", "evil"], ["a".repeat(65)],
                     ["users", "me?x=1"], Array(9).fill("a"), ["users", ""]]) {
    assert.equal(segmentsToPath(bad), null, JSON.stringify(bad));
  }
  assert.equal(segmentsToPath(["users", "me"]), "/users/me");
});

test("proxy: cabeçalhos do navegador NÃO são repassados; destino fixo; sem redirecionamento", async () => {
  const env = setup();
  const { cookie } = await login(env);
  const headers = { authorization: "Bearer forjado", "x-forwarded-for": "6.6.6.6", "x-prazoai-client-ip": "6.6.6.6",
    "x-prazoai-proxy-secret": "forjado", host: "evil.example", "x-custom": "1" };
  await env.bff.proxy(req("GET", "/bff/api/users/me", { cookie, headers }), "/users/me");
  const call = env.backend.calls.at(-1);
  assert.deepEqual(Object.keys(call.headers).sort(), ["accept", "authorization"]);
  assert.equal(call.headers.authorization, `Bearer ${env.backend.current.access}`);
  assert.equal(call.redirect, "manual");
  env.backend.failNext = "redirect";
  const r = await env.bff.proxy(req("GET", "/bff/api/users/me", { cookie }), "/users/me");
  assert.equal(r.status, 503);
});

test("proxy: limites de corpo e JSON inválido", async () => {
  const env = setup({ PRAZOAI_BFF_MAX_BODY_BYTES: "1024" });
  const { cookie } = await login(env);
  const big = await env.bff.proxy(req("PATCH", "/bff/api/users/me", { cookie, body: { name: "x".repeat(2000) } }), "/users/me");
  assert.equal(big.status, 413);
  const h = new Headers({ "x-prazoai-csrf": "1", origin: ORIGIN, cookie, "content-type": "application/json" });
  const bad = await env.bff.proxy(new Request(`${ORIGIN}/bff/api/users/me`, { method: "PATCH", headers: h, body: "{x" }), "/users/me");
  assert.equal(bad.status, 422);
});

test("CSRF: cabeçalho próprio sempre; Origin nas mutações (inclusive login e logout)", async () => {
  const env = setup();
  const body = { email: "a@b.com", password: "x" };
  assert.equal((await env.bff.login(req("POST", "/bff/auth/login", { body, csrf: false }))).status, 403);
  assert.equal((await env.bff.login(req("POST", "/bff/auth/login", { body, origin: null }))).status, 403);
  assert.equal((await env.bff.login(req("POST", "/bff/auth/login", { body, origin: "http://evil.example" }))).status, 403);
  assert.equal((await env.bff.logout(req("POST", "/bff/auth/logout", { origin: "http://evil.example" }))).status, 403);
  assert.equal((await env.bff.session(req("GET", "/bff/session", { csrf: false }))).status, 403);
  assert.equal((await env.bff.session(req("GET", "/bff/session", { origin: null }))).status, 200);   // GET: só o cabeçalho
  assert.equal(env.backend.calls.length, 0);
});

test("IP do cliente: sem configuração nada é encaminhado; com infraestrutura confiável, só IP válido", async () => {
  let env = setup();
  await env.bff.login(req("POST", "/bff/auth/login", { body: { email: "a@b.com", password: "x" }, headers: { "x-real-ip": "203.0.113.5" } }));
  assert.equal(env.backend.calls.at(-1).headers["x-prazoai-client-ip"], undefined);
  env = setup({ PRAZOAI_PROXY_SECRET: "s".repeat(40), PRAZOAI_TRUSTED_CLIENT_IP_HEADER: "x-real-ip" });
  await env.bff.login(req("POST", "/bff/auth/login", { body: { email: "a@b.com", password: "x" }, headers: { "x-real-ip": "203.0.113.5" } }));
  assert.equal(env.backend.calls.at(-1).headers["x-prazoai-client-ip"], "203.0.113.5");
  assert.equal(env.backend.calls.at(-1).headers["x-prazoai-proxy-secret"], "s".repeat(40));
  await env.bff.login(req("POST", "/bff/auth/login", { body: { email: "a@b.com", password: "x" }, headers: { "x-real-ip": "1.2.3.4, 5.6.7.8" } }));
  assert.equal(env.backend.calls.at(-1).headers["x-prazoai-client-ip"], undefined);
});

test("capacidade do BFF: novo login recusado com 503 e tokens revogados no backend", async () => {
  const env = setup({ PRAZOAI_BFF_MAX_SESSIONS: "1" });
  await login(env);
  const r = await env.bff.login(req("POST", "/bff/auth/login", { body: { email: "b@b.com", password: "x" } }));
  assert.equal(r.status, 503);
  assert.equal((await r.json()).error.code, "session_capacity_reached");
  assert.equal(env.store.size, 1);
});
