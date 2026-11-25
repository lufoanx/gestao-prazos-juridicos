// Implantação (doc 27) — INTEGRAÇÃO REAL: várias instâncias do BFF com sessões COMPARTILHADAS no
// PostgreSQL contra o FastAPI de verdade (memória ou PostgreSQL conforme STORAGE/DATABASE_URL do
// ambiente) e, para a recuperação de senha, o capturador SMTP local (Mailpit).
//
// Requer PRAZOAI_TEST_BFF_DATABASE_URL (PostgreSQL DESCARTÁVEL, banco *_test; o esquema prazoai_bff é
// recriado). Sem ela, os testes são PULADOS — ou FALHAM com PRAZOAI_REQUIRE_BFF_PG_TESTS=1 (CI).
// Sem PRAZOAI_TEST_MAILPIT_*, só o cenário de recuperação é pulado (ou falha com PRAZOAI_REQUIRE_MAILPIT_TESTS=1).
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { loadBffConfig } from "../../src/server/bff/config.mjs";
import { createBff } from "../../src/server/bff/manager.mjs";
import { createSessionStore } from "../../src/server/bff/instance.mjs";
import { migrate } from "../../src/server/bff/session-schema.mjs";
import { mailpitFromEnv, tokenFrom } from "../helpers/mailpit.mjs";

const BACKEND_DIR = fileURLToPath(new URL("../../../backend", import.meta.url));
const PYTHON = process.env.PRAZOAI_TEST_PYTHON || "python3";
const ORIGIN = "http://localhost:3000";
const PROXY_SECRET = randomBytes(32).toString("hex");
const DB_URL = process.env.PRAZOAI_TEST_BFF_DATABASE_URL || "";
const REQUIRE = process.env.PRAZOAI_REQUIRE_BFF_PG_TESTS === "1";
const MAILPIT = mailpitFromEnv();
const PASSWORD = "Senha-de-teste-123";
const SKIP = DB_URL ? false : "PRAZOAI_TEST_BFF_DATABASE_URL não definida";
if (!DB_URL && REQUIRE) throw new Error("PRAZOAI_REQUIRE_BFF_PG_TESTS=1 exige PRAZOAI_TEST_BFF_DATABASE_URL");
if (DB_URL && !/(_test$|^prazoai_test)/.test(new URL(DB_URL).pathname.slice(1))) throw new Error("banco de teste deve ser descartável");

// Faixa própria (17000–17899): não se sobrepõe às dos demais arquivos de integração.
const PORT = 17000 + Math.floor(Math.random() * 900);
const BASE = `http://127.0.0.1:${PORT}`;
const KEY = randomBytes(32).toString("base64url");
let proc;
const stores = [];

before(async () => {
  if (!DB_URL) return;
  const c = new pg.Client({ connectionString: DB_URL });
  await c.connect();
  try { await c.query("DROP SCHEMA IF EXISTS prazoai_bff CASCADE"); await migrate(c); } finally { await c.end(); }
  const mail = MAILPIT ? {
    EMAIL_TRANSPORT: "smtp", PUBLIC_APP_ORIGIN: ORIGIN, EMAIL_FROM: "PrazoAI <nao-responda@exemplo.com>",
    SMTP_HOST: MAILPIT.smtp.host, SMTP_PORT: MAILPIT.smtp.port, SMTP_SECURITY: "none", SMTP_ALLOW_INSECURE_LOCAL: "true",
  } : {};
  proc = spawn(PYTHON, ["-m", "uvicorn", "app.main:app", "--port", String(PORT), "--host", "127.0.0.1", "--no-proxy-headers"], {
    cwd: BACKEND_DIR,
    env: { ...process.env, ENVIRONMENT: "test", AUTH_JWT_SECRET: randomBytes(32).toString("hex"),
      TRUSTED_PROXY_SECRET: PROXY_SECRET, LOG_LEVEL: "WARNING", ...mail },
    stdio: ["ignore", "ignore", "pipe"],
  });
  if (MAILPIT) await MAILPIT.ready();
  for (let i = 0; i < 150; i++) {
    try { if ((await fetch(`${BASE}/api/v1/health`)).ok) return; } catch { /* subindo */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("backend não subiu");
});
after(async () => {
  proc?.kill("SIGTERM");
  await Promise.all(stores.map((s) => s.close().catch(() => {})));
});

/** Relógio COMPARTILHADO pelas instâncias (o tempo real também passa: só adiantamos). */
const clock = (() => { let skew = 0; return { now: () => Date.now() + skew, advance: (ms) => { skew += ms; } }; })();

async function instance({ wrapFetch } = {}) {
  const config = loadBffConfig({ PRAZOAI_APP_ENV: "test", PRAZOAI_APP_ORIGIN: ORIGIN, PRAZOAI_COOKIE_INSECURE_LOCAL: "true",
    PRAZOAI_BACKEND_URL: BASE, PRAZOAI_PROXY_SECRET: PROXY_SECRET, PRAZOAI_TRUSTED_CLIENT_IP_HEADER: "x-test-client-ip",
    PRAZOAI_BFF_SESSION_STORE: "postgres", PRAZOAI_BFF_DATABASE_URL: DB_URL, PRAZOAI_BFF_SESSION_KEY: KEY });
  const store = await createSessionStore(config, { now: clock.now });
  stores.push(store);
  const calls = [];
  const observed = async (url, init) => { calls.push(new URL(url).pathname.replace("/api/v1", "")); return fetch(url, init); };
  const fetchImpl = wrapFetch ? wrapFetch(observed) : observed;
  return { bff: createBff({ config, store, fetchImpl, now: clock.now, logger: { info() {}, error() {} }, refreshPollMs: 20 }), store, calls };
}

let ipSeq = 1;
const nextIp = () => `198.51.100.${(ipSeq++ % 250) + 1}`;
function req(method, path, { body, cookie, ip = "198.51.100.250" } = {}) {
  const h = new Headers({ "x-prazoai-csrf": "1", origin: ORIGIN, "x-test-client-ip": ip });
  if (cookie) h.set("cookie", cookie);
  if (body) h.set("content-type", "application/json");
  return new Request(`${ORIGIN}${path}`, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
}
const cookieOf = (r) => r.headers.getSetCookie().filter((c) => !c.includes("Max-Age=0")).map((c) => c.split(";")[0]).join("; ");
const sidOf = (cookie) => cookie.split("; ").find((c) => /_sid_/.test(c)).split("=")[1];

async function account(inst) {
  const ip = nextIp();
  const email = `s${randomBytes(5).toString("hex")}@exemplo.com`;
  const reg = await inst.bff.register(req("POST", "/bff/auth/register", { body: { name: "Pessoa Fictícia", email, password: PASSWORD }, ip }));
  assert.equal(reg.status, 201);
  const r = await inst.bff.login(req("POST", "/bff/auth/login", { body: { email, password: PASSWORD }, ip }));
  assert.equal(r.status, 200);
  return { email, ip, cookie: cookieOf(r) };
}

test("real: login em A, uso em B, reinício (instância nova) e logout em B revogando no backend", { skip: SKIP }, async () => {
  const A = await instance();
  const B = await instance();
  const a = await account(A);
  let r = await B.bff.proxy(req("GET", "/bff/api/users/me", { cookie: a.cookie }), "/users/me");
  assert.equal(r.status, 200);
  assert.equal((await r.json()).email, a.email);
  const access = (await B.store.get(sidOf(a.cookie))).accessToken;
  await A.store.close();                                                   // "reinício" da instância A
  const C = await instance();
  r = await C.bff.session(req("GET", "/bff/session", { cookie: a.cookie }));
  assert.equal((await r.json()).user.email, a.email);
  r = await B.bff.logout(req("POST", "/bff/auth/logout", { cookie: a.cookie }));
  assert.equal(r.status, 204);
  r = await C.bff.proxy(req("GET", "/bff/api/users/me", { cookie: a.cookie }), "/users/me");
  assert.equal(r.status, 401);
  const direct = await fetch(`${BASE}/api/v1/auth/me`, { headers: { authorization: `Bearer ${access}` } });
  assert.equal(direct.status, 401, "token revogado no backend");
});

test("real: renovação concorrente em duas instâncias faz UM refresh e o backend não detecta reutilização", { skip: SKIP }, async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  let reached;
  const reachedP = new Promise((r) => { reached = r; });
  const A = await instance({ wrapFetch: (f) => async (url, init) => {
    if (new URL(url).pathname.endsWith("/auth/refresh")) { reached(); await gate; }
    return f(url, init);
  } });
  const B = await instance();
  const a = await account(A);
  clock.advance(16 * 60 * 1000);                                           // access token (15 min) vencido para o BFF
  const pa = A.bff.proxy(req("GET", "/bff/api/users/me", { cookie: a.cookie }), "/users/me");
  await reachedP;
  const pb = B.bff.proxy(req("GET", "/bff/api/users/me", { cookie: a.cookie }), "/users/me");
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(B.calls.filter((p) => p === "/auth/refresh").length, 0, "B aguardou o lease de A");
  release();
  const [ra, rb] = await Promise.all([pa, pb]);
  assert.deepEqual([ra.status, rb.status], [200, 200]);
  assert.equal(A.calls.filter((p) => p === "/auth/refresh").length + B.calls.filter((p) => p === "/auth/refresh").length, 1);
  // Uma segunda renovação (próxima geração) continua válida: a família não foi revogada por reutilização.
  clock.advance(16 * 60 * 1000);
  const r = await B.bff.proxy(req("GET", "/bff/api/users/me", { cookie: a.cookie }), "/users/me");
  assert.equal(r.status, 200);
});

/** Gate na resposta REAL do backend: a chamada chega e é processada; a instância "trava" antes de persistir. */
function holdAfterBackend(path) {
  let consumed; let resume;
  const consumedP = new Promise((r) => { consumed = r; });
  const resumeP = new Promise((r) => { resume = r; });
  const wrap = (f) => async (url, init) => {
    const r = await f(url, init);
    if (new URL(url).pathname.endsWith(path)) { consumed(); await resumeP; }
    return r;
  };
  return { wrap, consumed: consumedP, resume };
}
const LEASE_MS = 10_000 + 5_000;                                          // PRAZOAI_BFF_TIMEOUT_MS padrão + margem

test("real: backend consome o refresh, A falha antes de persistir; B NÃO reenvia o token antigo; A tardia não ressuscita", { skip: SKIP }, async () => {
  const gate = holdAfterBackend("/auth/refresh");
  const A = await instance({ wrapFetch: gate.wrap });
  const B = await instance();
  const a = await account(A);
  const sid = sidOf(a.cookie);
  clock.advance(16 * 60 * 1000);                                          // access vencido para o BFF
  const pa = A.bff.proxy(req("GET", "/bff/api/users/me", { cookie: a.cookie }), "/users/me");
  await gate.consumed;                                                    // (a) o backend JÁ girou o par
  clock.advance(LEASE_MS + 1000);                                         // lease de A vence
  const rb = await B.bff.proxy(req("GET", "/bff/api/users/me", { cookie: a.cookie }), "/users/me");   // (b)
  assert.equal(rb.status, 401);                                           // (c) exige novo login
  assert.equal((await rb.json()).error.code, "session_refresh_uncertain");
  assert.equal(B.calls.filter((p) => p === "/auth/refresh").length, 0, "token antigo NÃO reenviado");
  assert.equal(await B.store.get(sid), null);
  gate.resume();                                                          // (d) resposta tardia de A
  const ra = await pa;
  assert.equal(ra.status, 401);
  assert.equal(await A.store.get(sid), null, "resposta tardia não ressuscita a sessão");
  const again = await B.bff.session(req("GET", "/bff/session", { cookie: a.cookie }));
  assert.equal((await again.json()).authenticated, false);
  // nova sessão com novo login funciona normalmente
  const relogin = await B.bff.login(req("POST", "/bff/auth/login", { body: { email: a.email, password: PASSWORD }, ip: a.ip }));
  assert.equal(relogin.status, 200);
});

test("real: A conclui no backend depois de perder o lease (sem outra instância): resultado descartado e par revogado", { skip: SKIP }, async () => {
  let release;
  const go = new Promise((r) => { release = r; });
  let reached;
  const reachedP = new Promise((r) => { reached = r; });
  let newAccess = null;
  const A = await instance({ wrapFetch: (f) => async (url, init) => {
    if (new URL(url).pathname.endsWith("/auth/refresh")) {
      reached(); await go;
      const r = await f(url, init);
      newAccess = (await r.clone().json()).accessToken;
      return r;
    }
    return f(url, init);
  } });
  const a = await account(A);
  const sid = sidOf(a.cookie);
  clock.advance(16 * 60 * 1000);
  const pa = A.bff.proxy(req("GET", "/bff/api/users/me", { cookie: a.cookie }), "/users/me");
  await reachedP;
  clock.advance(LEASE_MS + 1000);
  release();
  const ra = await pa;
  assert.equal(ra.status, 401);
  assert.equal((await ra.json()).error.code, "session_refresh_uncertain");
  assert.equal(await A.store.get(sid), null);
  assert.ok(newAccess, "o backend emitiu um par novo");
  const direct = await fetch(`${BASE}/api/v1/auth/me`, { headers: { authorization: `Bearer ${newAccess}` } });
  assert.equal(direct.status, 401, "par emitido tardiamente revogado no backend");
});

test("real: contas isoladas entre instâncias (cada cookie vê só a própria conta)", { skip: SKIP }, async () => {
  const A = await instance();
  const B = await instance();
  const u1 = await account(A);
  const u2 = await account(B);
  const me1 = await (await B.bff.proxy(req("GET", "/bff/api/users/me", { cookie: u1.cookie }), "/users/me")).json();
  const me2 = await (await A.bff.proxy(req("GET", "/bff/api/users/me", { cookie: u2.cookie }), "/users/me")).json();
  assert.equal(me1.email, u1.email);
  assert.equal(me2.email, u2.email);
  await A.bff.logout(req("POST", "/bff/auth/logout", { cookie: u1.cookie }));
  assert.equal((await B.bff.proxy(req("GET", "/bff/api/users/me", { cookie: u2.cookie }), "/users/me")).status, 200);
});

test("real: redefinição de senha encerra as sessões do BFF em todas as instâncias", { skip: SKIP }, async (t) => {
  if (!MAILPIT) {
    if (process.env.PRAZOAI_REQUIRE_MAILPIT_TESTS === "1") throw new Error("capturador SMTP obrigatório");
    t.skip("capturador SMTP não configurado");
    return;
  }
  const A = await instance();
  const B = await instance();
  const a = await account(A);
  const before = await MAILPIT.count();
  let r = await B.bff.passwordForgot(req("POST", "/bff/public/password/forgot", { body: { email: a.email }, ip: nextIp() }));
  assert.equal(r.status, 202);
  assert.ok(await MAILPIT.waitCount(before + 1) >= before + 1);
  const [message] = (await MAILPIT.messagesTo(a.email)).slice(-1);
  const token = tokenFrom(message, ORIGIN);
  r = await A.bff.passwordReset(req("POST", "/bff/public/password/reset",
    { body: { token, newPassword: "Nova-senha-segura-456" }, ip: nextIp() }));
  assert.equal(r.status, 204);
  for (const inst of [A, B]) {
    r = await inst.bff.proxy(req("GET", "/bff/api/users/me", { cookie: a.cookie }), "/users/me");
    assert.equal(r.status, 401);
  }
  assert.equal(await A.store.get(sidOf(a.cookie)), null, "sessão removida do armazenamento compartilhado");
  // token de uso único
  r = await B.bff.passwordReset(req("POST", "/bff/public/password/reset",
    { body: { token, newPassword: "Outra-senha-segura-789" }, ip: nextIp() }));
  assert.notEqual(r.status, 204);
  await MAILPIT.deleteAll();
});
