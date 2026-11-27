// E4 (doc 21) — INTEGRAÇÃO REAL: rotas públicas de recuperação do BFF contra o FastAPI de verdade
// (uvicorn iniciado aqui; memória ou PostgreSQL conforme STORAGE/DATABASE_URL do ambiente) e o
// capturador SMTP local da E3 (Mailpit) para obter o token enviado pelo backend.
//
// Dois backends: um com a recuperação DESABILITADA (padrão `EMAIL_TRANSPORT=disabled`) e outro
// HABILITADO (`smtp` → capturador local, exceção sem TLS explícita e só em loopback/test).
// Sem as variáveis PRAZOAI_TEST_MAILPIT_*, os cenários habilitados são PULADOS (e FALHAM com
// PRAZOAI_REQUIRE_MAILPIT_TESTS=1, como no CI).
// Verificações com token, senha, e-mail ou corpo usam `check` (falha sem valores). Nada de sleep para
// ordenar: o resultado incerto é coordenado pelo sinal de abort do próprio BFF; a chegada de mensagens
// é uma condição observável na API do capturador.
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { loadBffConfig } from "../../src/server/bff/config.mjs";
import { createMemorySessionStore } from "../../src/server/bff/session-store.mjs";
import { createBff } from "../../src/server/bff/manager.mjs";
import { mailpitFromEnv, tokenFrom } from "../helpers/mailpit.mjs";
import { check } from "../helpers/sensitive.mjs";

const BACKEND_DIR = fileURLToPath(new URL("../../../backend", import.meta.url));
const PYTHON = process.env.PRAZOAI_TEST_PYTHON || "python3";
const ORIGIN = "http://localhost:3000";
const PROXY_SECRET = randomBytes(32).toString("hex");
const NEUTRAL = "Se o e-mail estiver cadastrado, enviaremos instruções de recuperação.";
const PASSWORD = "Senha-de-teste-123";
const NEW_PASSWORD = "Nova-senha-segura-456";
const MAILPIT = mailpitFromEnv();
const REQUIRE_MAILPIT = process.env.PRAZOAI_REQUIRE_MAILPIT_TESTS === "1";
const backends = {};

function startBackend(port, extraEnv) {
  const proc = spawn(PYTHON, ["-m", "uvicorn", "app.main:app", "--port", String(port), "--host", "127.0.0.1", "--no-proxy-headers"], {
    cwd: BACKEND_DIR,
    env: { ...process.env, ENVIRONMENT: "test", AUTH_JWT_SECRET: randomBytes(32).toString("hex"),
      TRUSTED_PROXY_SECRET: PROXY_SECRET, LOG_LEVEL: "WARNING", ...extraEnv },
    stdio: ["ignore", "ignore", "ignore"],
  });
  return { proc, base: `http://127.0.0.1:${port}` };
}

async function waitHealthy(base) {
  for (let i = 0; i < 150; i++) {
    try { if ((await fetch(`${base}/api/v1/health`)).ok) return; } catch { /* subindo */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("backend não subiu");
}

before(async () => {
  // Faixa própria (19500–19589): não se sobrepõe às dos demais arquivos de integração (18000–19499,
  // 19600–19899, 19900–19939, 19950–19989), nem enquanto um backend anterior ainda encerra.
  const port = 19500 + 2 * Math.floor(Math.random() * 45);
  backends.disabled = startBackend(port, { EMAIL_TRANSPORT: "disabled" });
  if (MAILPIT) {
    backends.enabled = startBackend(port + 1, {
      EMAIL_TRANSPORT: "smtp", PUBLIC_APP_ORIGIN: ORIGIN, EMAIL_FROM: "PrazoAI <nao-responda@exemplo.com>",
      SMTP_HOST: MAILPIT.smtp.host, SMTP_PORT: MAILPIT.smtp.port, SMTP_SECURITY: "none", SMTP_ALLOW_INSECURE_LOCAL: "true",
    });
    await MAILPIT.ready();
    await MAILPIT.deleteAll();
  }
  await Promise.all(Object.values(backends).map((b) => waitHealthy(b.base)));
});
after(async () => {
  for (const b of Object.values(backends)) b.proc.kill("SIGTERM");
  if (MAILPIT) await MAILPIT.deleteAll();                     // nada sensível fica no capturador
});

const enabledTest = (name, fn) => test(name, async (t) => {
  if (!MAILPIT) {
    assert.ok(!REQUIRE_MAILPIT, "PRAZOAI_REQUIRE_MAILPIT_TESTS=1 exige PRAZOAI_TEST_MAILPIT_SMTP/API.");
    t.skip("capturador SMTP não configurado");
    return;
  }
  await fn(t);
});

/** BFF com o mesmo protocolo de produção; `wrapFetch` permite observar/controlar o encaminhamento. */
function setup(which, { wrapFetch, env = {} } = {}) {
  const config = loadBffConfig({ PRAZOAI_APP_ENV: "test", PRAZOAI_APP_ORIGIN: ORIGIN, PRAZOAI_COOKIE_INSECURE_LOCAL: "true",
    PRAZOAI_BACKEND_URL: backends[which].base, PRAZOAI_PROXY_SECRET: PROXY_SECRET,
    PRAZOAI_TRUSTED_CLIENT_IP_HEADER: "x-test-client-ip", ...env });
  const store = createMemorySessionStore(config.session);
  const paths = [];
  const observed = async (url, init) => { paths.push(`${init.method} ${new URL(url).pathname}`); return fetch(url, init); };
  const fetchImpl = wrapFetch ? wrapFetch(observed) : observed;
  return { bff: createBff({ config, store, fetchImpl, logger: { info() {} } }), store, paths };
}

let ipSeq = 1;
const nextIp = () => `198.51.100.${(ipSeq++ % 250) + 1}`;
const email = () => `r${randomBytes(5).toString("hex")}@exemplo.com`;
function req(method, path, { body, cookie, ip, extra = {} } = {}) {
  const h = new Headers({ "x-prazoai-csrf": "1", origin: ORIGIN, ...extra });
  if (ip) h.set("x-test-client-ip", ip);
  if (cookie) h.set("cookie", cookie);
  if (body) h.set("content-type", "application/json");
  return new Request(`${ORIGIN}${path}`, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
}
const statusReq = (o) => req("GET", "/bff/public/password/status", o);
const forgotReq = (address, o = {}) => req("POST", "/bff/public/password/forgot", { body: { email: address }, ...o });
const resetReq = (token, newPassword, o = {}) => req("POST", "/bff/public/password/reset", { body: { token, newPassword }, ...o });

async function account(env, address = email()) {
  const ip = nextIp();
  const reg = await env.bff.register(req("POST", "/bff/auth/register", { body: { name: "Pessoa Fictícia", email: address, password: PASSWORD }, ip }));
  assert.equal(reg.status, 201);
  const r = await env.bff.login(req("POST", "/bff/auth/login", { body: { email: address, password: PASSWORD }, ip }));
  assert.equal(r.status, 200);
  const cookie = r.headers.get("set-cookie").split(";")[0];
  return { cookie, sid: cookie.split("=")[1], ip, email: address };
}

function noStoreNoCookie(r) {
  assert.equal(r.headers.get("cache-control"), "no-store, private");
  assert.equal(r.headers.getSetCookie().length, 0);
}

async function tokenFor(address, expected) {
  check((await MAILPIT.waitCount(expected)) >= expected, "capturador: mensagem esperada chegou");
  const msgs = await MAILPIT.messagesTo(address);
  check(msgs.length >= 1, "capturador: mensagem para a conta existente");
  return msgs.map((m) => tokenFrom(m, ORIGIN));
}

// ---------------------------------------------------------------- recuperação desabilitada
test("real (desabilitada): status false, forgot 503 sem efeito, reset com token inexistente 400; sessão intacta", async () => {
  const env = setup("disabled");
  const a = await account(env);
  const s = await env.bff.passwordStatus(statusReq({ cookie: a.cookie, ip: a.ip }));
  assert.equal(s.status, 200);
  assert.deepEqual(await s.json(), { available: false });
  noStoreNoCookie(s);
  const f = await env.bff.passwordForgot(forgotReq(a.email, { cookie: a.cookie, ip: a.ip }));
  assert.equal(f.status, 503);
  assert.equal((await f.json()).error.code, "password_recovery_unavailable");
  noStoreNoCookie(f);
  const r = await env.bff.passwordReset(resetReq("t".repeat(43), NEW_PASSWORD, { cookie: a.cookie, ip: a.ip }));
  assert.equal(r.status, 400);
  assert.equal((await r.json()).error.code, "invalid_reset_token");
  noStoreNoCookie(r);
  assert.ok(await env.store.get(a.sid), "sessão BFF continua viva");
  assert.deepEqual(env.paths.filter((p) => /refresh|logout|\/auth\/me/.test(p)), []);
});

// ---------------------------------------------------------------- recuperação habilitada (capturador real)
enabledTest("real (habilitada): status só { available: true }; forgot neutro para existente e inexistente", async () => {
  const env = setup("enabled");
  const s = await env.bff.passwordStatus(statusReq({ ip: nextIp() }));
  assert.deepEqual(await s.json(), { available: true });
  const a = await account(env);
  const before = await MAILPIT.count();
  const ip = nextIp();
  const missing = await env.bff.passwordForgot(forgotReq(email(), { ip }));   // processado ANTES (FIFO)
  const existing = await env.bff.passwordForgot(forgotReq(a.email, { ip }));
  assert.equal(missing.status, 202);
  assert.equal(existing.status, 202);
  assert.deepEqual(await missing.json(), { message: NEUTRAL });
  assert.deepEqual(await existing.json(), { message: NEUTRAL });
  noStoreNoCookie(existing);
  await tokenFor(a.email, before + 1);
  check((await MAILPIT.count()) === before + 1, "capturador: nenhuma mensagem para conta inexistente");
});

enabledTest("real: token recebido redefine (204, sem login); sessão BFF intocada pela rota pública e revogada no fluxo normal", async () => {
  const env = setup("enabled");
  const a = await account(env);
  const before = await MAILPIT.count();
  assert.equal((await env.bff.passwordForgot(forgotReq(a.email, { cookie: a.cookie, ip: a.ip }))).status, 202);
  const [token] = await tokenFor(a.email, before + 1);
  const publicStart = env.paths.length;
  const r = await env.bff.passwordReset(resetReq(token, NEW_PASSWORD, { cookie: a.cookie, ip: a.ip }));
  assert.equal(r.status, 204);
  assert.equal(await r.text(), "");
  noStoreNoCookie(r);                                                      // nenhum cookie criado ou apagado
  assert.ok(await env.store.get(a.sid), "rota pública não apagou a sessão BFF");
  assert.deepEqual(env.paths.slice(publicStart), ["POST /api/v1/auth/reset-password"]);   // sem refresh/me/logout
  const again = await env.bff.passwordReset(resetReq(token, "Outra-senha-789", { ip: a.ip }));
  assert.equal(again.status, 400);
  assert.equal((await again.json()).error.code, "invalid_reset_token");   // consumo único
  const oldLogin = await env.bff.login(req("POST", "/bff/auth/login", { body: { email: a.email, password: PASSWORD }, ip: nextIp() }));
  const newLogin = await env.bff.login(req("POST", "/bff/auth/login", { body: { email: a.email, password: NEW_PASSWORD }, ip: nextIp() }));
  assert.equal(oldLogin.status, 401);
  assert.equal(newLogin.status, 200);
  // Fluxo NORMAL da sessão antiga: o backend a revogou; o BFF descobre no próximo uso autenticado.
  const me = await env.bff.proxy(req("GET", "/bff/api/users/me", { cookie: a.cookie, ip: a.ip }), "/users/me");
  assert.equal(me.status, 401);
});

enabledTest("real: dois pedidos — duas mensagens, token substituído recusado, último aceito", async () => {
  const env = setup("enabled");
  const a = await account(env);
  const before = await MAILPIT.count();
  assert.equal((await env.bff.passwordForgot(forgotReq(a.email, { ip: a.ip }))).status, 202);
  await tokenFor(a.email, before + 1);
  assert.equal((await env.bff.passwordForgot(forgotReq(a.email, { ip: a.ip }))).status, 202);
  const [first, second] = await tokenFor(a.email, before + 2);
  check(first !== second, "dois pedidos: tokens distintos");
  const r1 = await env.bff.passwordReset(resetReq(first, NEW_PASSWORD, { ip: a.ip }));
  const r2 = await env.bff.passwordReset(resetReq(second, NEW_PASSWORD, { ip: a.ip }));
  assert.equal(r1.status, 400);
  assert.equal(r2.status, 204);
});

enabledTest("real: limites por e-mail e por IP com Retry-After; IP só pelo mecanismo confiável (forjado não muda nada)", async () => {
  const env = setup("enabled");
  const target = email();
  const ip1 = nextIp();
  for (let i = 0; i < 3; i++) assert.equal((await env.bff.passwordForgot(forgotReq(target, { ip: nextIp() }))).status, 202);
  const perEmail = await env.bff.passwordForgot(forgotReq(target, { ip: nextIp() }));
  assert.equal(perEmail.status, 429);
  assert.equal(perEmail.headers.get("retry-after"), "900");
  noStoreNoCookie(perEmail);
  for (let i = 0; i < 10; i++) {
    const forged = { "x-forwarded-for": `203.0.113.${i + 1}`, "x-prazoai-client-ip": `203.0.113.${i + 1}` };
    assert.equal((await env.bff.passwordForgot(forgotReq(email(), { ip: ip1, extra: forged }))).status, 202);
  }
  const perIp = await env.bff.passwordForgot(forgotReq(email(), { ip: ip1, extra: { "x-forwarded-for": "203.0.113.200" } }));
  assert.equal(perIp.status, 429);
  assert.ok(Number(perIp.headers.get("retry-after")) > 0);
  assert.equal((await env.bff.passwordForgot(forgotReq(email(), { ip: nextIp() }))).status, 202);   // outro IP confiável
});

enabledTest("real: timeout após o envio — 504 resultado desconhecido, UM encaminhamento, operação concluída no backend", async () => {
  const forwarded = [];
  // O fetch REAL vai ao backend e conclui; a resposta só é "entregue" depois que o prazo do BFF
  // dispara (espera pelo sinal de abort, sem sleep). Simula a resposta perdida após o processamento.
  const late = (inner) => async (url, init) => {
    forwarded.push(new URL(url).pathname);
    const { signal, ...rest } = init;
    const res = await inner(url, rest);
    await res.arrayBuffer();                                              // processado por completo
    await new Promise((resolve) => { if (signal.aborted) resolve(); else signal.addEventListener("abort", resolve, { once: true }); });
    throw signal.reason;
  };
  const plain = setup("enabled");
  const a = await account(plain);
  const env = setup("enabled", { wrapFetch: late, env: { PRAZOAI_BFF_TIMEOUT_MS: "3000" } });
  const before = await MAILPIT.count();
  const f = await env.bff.passwordForgot(forgotReq(a.email, { cookie: a.cookie, ip: a.ip }));
  assert.equal(f.status, 504);
  assert.equal((await f.json()).outcome, "unknown");
  noStoreNoCookie(f);
  assert.deepEqual(forwarded, ["/api/v1/auth/forgot-password"]);          // exatamente um encaminhamento
  const [token] = await tokenFor(a.email, before + 1);                     // e o pedido foi processado
  forwarded.length = 0;
  const r = await env.bff.passwordReset(resetReq(token, NEW_PASSWORD, { cookie: a.cookie, ip: a.ip }));
  assert.equal(r.status, 504);
  assert.equal((await r.json()).outcome, "unknown");
  assert.deepEqual(forwarded, ["/api/v1/auth/reset-password"]);
  const login = await plain.bff.login(req("POST", "/bff/auth/login", { body: { email: a.email, password: NEW_PASSWORD }, ip: nextIp() }));
  assert.equal(login.status, 200);                                         // a redefinição TINHA ocorrido
  assert.ok(await plain.store.get(a.sid), "sessão BFF de origem não foi tocada pelas rotas públicas");
});
