// Etapa 6.1 — INTEGRAÇÃO REAL: núcleo do BFF contra o FastAPI de verdade (uvicorn iniciado aqui).
// Sem dublês do backend. Requer o Python com as dependências do backend:
//   PRAZOAI_TEST_PYTHON=/caminho/python npm run test:integration
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { loadBffConfig } from "../../src/server/bff/config.mjs";
import { createMemorySessionStore } from "../../src/server/bff/session-store.mjs";
import { createBff } from "../../src/server/bff/manager.mjs";

const BACKEND_DIR = fileURLToPath(new URL("../../../backend", import.meta.url));
const PYTHON = process.env.PRAZOAI_TEST_PYTHON || "python3";
const PORT = 18000 + Math.floor(Math.random() * 1500);
const BASE = `http://127.0.0.1:${PORT}`;
const ORIGIN = "http://localhost:3000";
const PROXY_SECRET = randomBytes(32).toString("hex");
let proc;

before(async () => {
  proc = spawn(PYTHON, ["-m", "uvicorn", "app.main:app", "--port", String(PORT), "--host", "127.0.0.1", "--no-proxy-headers"], {
    cwd: BACKEND_DIR,
    env: { ...process.env, ENVIRONMENT: "test", AUTH_JWT_SECRET: randomBytes(32).toString("hex"),
      TRUSTED_PROXY_SECRET: PROXY_SECRET, AUTH_REGISTER_MAX_REQUESTS: "3", LOG_LEVEL: "WARNING" },
    stdio: ["ignore", "ignore", "pipe"],
  });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${BASE}/api/v1/health`)).ok) return; } catch { /* subindo */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("backend não subiu");
});
after(() => { proc?.kill("SIGTERM"); });

function setup({ wrapFetch } = {}) {
  let t = Date.now();
  const clock = { now: () => t, advance: (ms) => { t += ms; } };
  const config = loadBffConfig({ PRAZOAI_APP_ENV: "test", PRAZOAI_APP_ORIGIN: ORIGIN, PRAZOAI_COOKIE_INSECURE_LOCAL: "true",
    PRAZOAI_BACKEND_URL: BASE, PRAZOAI_PROXY_SECRET: PROXY_SECRET, PRAZOAI_TRUSTED_CLIENT_IP_HEADER: "x-test-client-ip" });
  const store = createMemorySessionStore(config.session, clock.now);
  const fetchImpl = wrapFetch ? wrapFetch(fetch) : fetch;
  return { bff: createBff({ config, store, fetchImpl, now: clock.now, logger: { info() {} } }), store, clock };
}

let ipSeq = 1;
const nextIp = () => `198.51.100.${ipSeq++}`;
function req(method, path, { body, cookie, ip }) {
  const h = new Headers({ "x-prazoai-csrf": "1", origin: ORIGIN, "x-test-client-ip": ip });
  if (cookie) h.set("cookie", cookie);
  if (body) h.set("content-type", "application/json");
  return new Request(`${ORIGIN}${path}`, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
}

async function account(env) {
  const ip = nextIp();
  const email = `u${randomBytes(4).toString("hex")}@exemplo.com`;
  const password = "Senha-de-teste-123";
  const reg = await env.bff.register(req("POST", "/bff/auth/register", { body: { name: "Pessoa", email, password }, ip }));
  assert.equal(reg.status, 201, await reg.clone().text());
  const r = await env.bff.login(req("POST", "/bff/auth/login", { body: { email, password }, ip }));
  assert.equal(r.status, 200);
  return { cookie: r.headers.get("set-cookie").split(";")[0], ip, email, password, body: await r.json() };
}

test("real: cadastro, login, sessão, perfil e logout com revogação no backend", async () => {
  const env = setup();
  const a = await account(env);
  assert.deepEqual(Object.keys(a.body), ["user"]);
  const s = await env.bff.session(req("GET", "/bff/session", { cookie: a.cookie, ip: a.ip }));
  assert.equal((await s.json()).user.email, a.email);
  const p = await env.bff.proxy(req("PATCH", "/bff/api/users/me", { cookie: a.cookie, ip: a.ip, body: { name: "Nome Novo" } }), "/users/me");
  assert.equal((await p.json()).name, "Nome Novo");
  const access = [...[env.store]][0] && env.store.get(a.cookie.split("=")[1]).accessToken;
  assert.equal((await env.bff.logout(req("POST", "/bff/auth/logout", { cookie: a.cookie, ip: a.ip }))).status, 204);
  const direct = await fetch(`${BASE}/api/v1/auth/me`, { headers: { authorization: `Bearer ${access}` } });
  assert.equal(direct.status, 401);                                  // revogado no backend
  const after = await env.bff.session(req("GET", "/bff/session", { cookie: a.cookie, ip: a.ip }));
  assert.deepEqual(await after.json(), { authenticated: false });
});

test("real: duas abas forçando renovação → uma rotação, sessão continua válida", async () => {
  let refreshes = 0;
  const env = setup({ wrapFetch: (f) => (url, init) => { if (String(url).endsWith("/auth/refresh")) refreshes++; return f(url, init); } });
  const a = await account(env);
  env.clock.advance(890_000);
  const results = await Promise.all([
    env.bff.proxy(req("GET", "/bff/api/users/me", { cookie: a.cookie, ip: a.ip }), "/users/me"),
    env.bff.proxy(req("GET", "/bff/api/auth/me", { cookie: a.cookie, ip: a.ip }), "/auth/me"),
    env.bff.session(req("GET", "/bff/session", { cookie: a.cookie, ip: a.ip })),
  ]);
  assert.deepEqual(results.map((r) => r.status), [200, 200, 200]);
  assert.equal(refreshes, 1);
  const again = await env.bff.proxy(req("GET", "/bff/api/users/me", { cookie: a.cookie, ip: a.ip }), "/users/me");
  assert.equal(again.status, 200);                                   // detecção de reutilização não disparou
});

test("real: reutilização do refresh antigo revoga a família e o BFF encerra a sessão", async () => {
  const env = setup();
  const a = await account(env);
  const sid = a.cookie.split("=")[1];
  const oldRefresh = env.store.get(sid).refreshToken;
  env.clock.advance(890_000);
  assert.equal((await env.bff.proxy(req("GET", "/bff/api/users/me", { cookie: a.cookie, ip: a.ip }), "/users/me")).status, 200);
  const replay = await fetch(`${BASE}/api/v1/auth/refresh`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ refreshToken: oldRefresh }) });
  assert.equal(replay.status, 401);
  const r = await env.bff.proxy(req("GET", "/bff/api/users/me", { cookie: a.cookie, ip: a.ip }), "/users/me");
  assert.equal(r.status, 401);
  assert.equal(env.store.get(sid), null);
});

test("real: logout concorrendo com renovação não recria a sessão", async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const env = setup({ wrapFetch: (f) => async (url, init) => {
    if (String(url).endsWith("/auth/refresh")) await gate;
    return f(url, init);
  } });
  const a = await account(env);
  env.clock.advance(890_000);
  const pending = env.bff.proxy(req("GET", "/bff/api/users/me", { cookie: a.cookie, ip: a.ip }), "/users/me");
  await new Promise((r) => setTimeout(r, 20));
  assert.equal((await env.bff.logout(req("POST", "/bff/auth/logout", { cookie: a.cookie, ip: a.ip }))).status, 204);
  release();
  assert.equal((await pending).status, 401);
  assert.equal(env.store.size, 0);
});

test("real: 429 preservado com Retry-After e limites separados por cliente encaminhado", async () => {
  const env = setup();
  const a = await account(env);
  for (let i = 0; i < 5; i++) {
    await env.bff.login(req("POST", "/bff/auth/login", { body: { email: a.email, password: "errada-123" }, ip: a.ip }));
  }
  const limited = await env.bff.login(req("POST", "/bff/auth/login", { body: { email: a.email, password: a.password }, ip: a.ip }));
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get("retry-after")) > 0);
  const other = await env.bff.login(req("POST", "/bff/auth/login", { body: { email: a.email, password: a.password }, ip: nextIp() }));
  assert.equal(other.status, 200);                                   // outro cliente, outro limite
  // Cadastro: 3 por IP; o 4º do mesmo IP é 429, outro IP segue livre.
  const ip = nextIp();
  for (let i = 0; i < 3; i++) {
    const r = await env.bff.register(req("POST", "/bff/auth/register", { body: { name: "P", email: `r${i}${ip}@exemplo.com`.replace(/\./g, "") + ".com", password: "Senha-de-teste-123" }, ip }));
    assert.equal(r.status, 201);
  }
  const fourth = await env.bff.register(req("POST", "/bff/auth/register", { body: { name: "P", email: "quarto@exemplo.com", password: "Senha-de-teste-123" }, ip }));
  assert.equal(fourth.status, 429);
});

test("real: segredo incorreto direto no backend → IP forjado ignorado", async () => {
  const forged = (ip) => fetch(`${BASE}/api/v1/auth/register`, { method: "POST",
    headers: { "content-type": "application/json", "x-prazoai-proxy-secret": "x".repeat(64), "x-prazoai-client-ip": ip, "x-forwarded-for": ip },
    body: JSON.stringify({ name: "P", email: `f${randomBytes(3).toString("hex")}@exemplo.com`, password: "Senha-de-teste-123" }) });
  const codes = [];
  for (let i = 0; i < 4; i++) codes.push((await forged(`203.0.113.${i}`)).status);
  assert.ok(codes.includes(429), JSON.stringify(codes));             // todos contaram no IP observado
});

// ---------------------------------------------------------------- auditoria 6.1
test("real (auditoria): login pausado + logout em outra aba não instala sessão", async () => {
  let release;
  let hold = false;
  const gate = new Promise((r) => { release = r; });
  const env = setup({ wrapFetch: (f) => async (url, init) => {
    if (hold && String(url).endsWith("/auth/login")) await gate;
    return f(url, init);
  } });
  const a = await account(env);
  hold = true;
  const pending = env.bff.login(req("POST", "/bff/auth/login", { cookie: a.cookie, ip: a.ip, body: { email: a.email, password: a.password } }));
  await new Promise((r) => setTimeout(r, 30));
  assert.equal((await env.bff.logout(req("POST", "/bff/auth/logout", { cookie: a.cookie, ip: a.ip }))).status, 204);
  release();
  const late = await pending;
  assert.equal(late.status, 409);
  assert.equal(env.store.size, 0);
  hold = false;
  const fresh = await env.bff.login(req("POST", "/bff/auth/login", { ip: a.ip, body: { email: a.email, password: a.password } }));
  assert.equal(fresh.status, 200);                                     // login explícito depois do logout
});

test("real (auditoria): corpo do refresh 200 interrompido → sessão invalidada, sem reenviar o refresh", async () => {
  let refreshes = 0;
  const env = setup({ wrapFetch: (f) => async (url, init) => {
    const res = await f(url, init);
    if (String(url).endsWith("/auth/refresh")) {
      refreshes++;
      if (res.status === 200) {
        await res.text();                                              // o backend JÁ girou o token
        return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('{"access')); c.error(new Error("caiu")); } }),
          { status: 200, headers: { "content-type": "application/json" } });
      }
    }
    return res;
  } });
  const a = await account(env);
  const sid = a.cookie.split("=")[1];
  const oldRefresh = env.store.get(sid).refreshToken;
  env.clock.advance(890_000);
  const r1 = await env.bff.session(req("GET", "/bff/session", { cookie: a.cookie, ip: a.ip }));
  assert.equal(r1.status, 401);
  assert.equal((await r1.json()).error.code, "session_refresh_uncertain");
  const r2 = await env.bff.proxy(req("GET", "/bff/api/users/me", { cookie: a.cookie, ip: a.ip }), "/users/me");
  assert.equal(r2.status, 401);
  assert.equal(refreshes, 1);                                          // nunca reenviado
  const replay = await fetch(`${BASE}/api/v1/auth/refresh`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ refreshToken: oldRefresh }) });
  assert.equal(replay.status, 401);                                    // confirma que a rotação ocorreu no backend
});

// Deve ser o ÚLTIMO: derruba o backend.
test("real: backend fora do ar → 503 sem logout nem dados demonstrativos", async () => {
  const env = setup();
  const a = await account(env);
  proc.kill("SIGTERM");
  await new Promise((r) => proc.once("exit", r));
  const r = await env.bff.proxy(req("GET", "/bff/api/users/me", { cookie: a.cookie, ip: a.ip }), "/users/me");
  assert.equal(r.status, 503);
  assert.equal((await r.json()).error.code, "backend_unavailable");
  assert.ok(env.store.get(a.cookie.split("=")[1]));                  // sessão preservada
  const s = await env.bff.session(req("GET", "/bff/session", { cookie: a.cookie, ip: a.ip }));
  assert.equal(s.status, 503);
});
