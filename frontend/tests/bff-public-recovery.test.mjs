// E4 (doc 21) — rotas PÚBLICAS de recuperação de senha no BFF: testes UNITÁRIOS com backend DUBLÊ
// (fetch injetado). A integração real BFF × FastAPI está em tests/integration/recovery-backend.test.mjs.
// Dados fictícios; verificações com token/senha/e-mail usam `check` (falha sem valores).
import test from "node:test";
import assert from "node:assert/strict";
import { loadBffConfig } from "../src/server/bff/config.mjs";
import { createMemorySessionStore } from "../src/server/bff/session-store.mjs";
import { createBff } from "../src/server/bff/manager.mjs";
import { PROXY_ALLOWLIST, matchAllowlist } from "../src/server/bff/allowlist.mjs";
import { validateForgotBody, validateResetBody } from "../src/server/bff/public-recovery.mjs";
import { check, checkAbsent } from "./helpers/sensitive.mjs";

const ORIGIN = "http://localhost:3000";
const SECRET = "s".repeat(40);
const TOKEN = "Tk_" + "x".repeat(40);
const PASSWORD = "Senha-ficticia-123";
const EMAIL = "ficticia@exemplo.com";
const NEUTRAL = "Se o e-mail estiver cadastrado, enviaremos instruções de recuperação.";
const SID = "prazoai_sid_abcdefghij=" + "A".repeat(43);
const jsonRes = (status, body, headers = {}) => new Response(body === null ? null : JSON.stringify(body),
  { status, headers: { "content-type": "application/json", ...headers } });

function setup(handler, env = {}) {
  const config = loadBffConfig({ PRAZOAI_APP_ENV: "test", PRAZOAI_APP_ORIGIN: ORIGIN, PRAZOAI_COOKIE_INSECURE_LOCAL: "true",
    PRAZOAI_PROXY_SECRET: SECRET, PRAZOAI_TRUSTED_CLIENT_IP_HEADER: "x-test-client-ip", ...env });
  const store = createMemorySessionStore(config.session);
  const storeCalls = [];
  for (const k of Object.keys(store)) {                      // qualquer acesso ao armazenamento é registrado
    if (typeof store[k] === "function") {
      const orig = store[k].bind(store);
      store[k] = (...a) => { storeCalls.push(k); return orig(...a); };
    }
  }
  const calls = [];
  const logs = [];
  const fetchImpl = async (url, init) => { calls.push({ url, init }); return handler(url, init, calls.length); };
  const bff = createBff({ config, store, fetchImpl, logger: { info: (...a) => logs.push(JSON.stringify(a)) } });
  return { bff, calls, logs, storeCalls };
}

function request(path, { method = "POST", body, raw, csrf = true, origin = ORIGIN, cookie = SID, extra = {}, query = "" } = {}) {
  const h = new Headers({ ...extra });
  if (csrf) h.set("x-prazoai-csrf", "1");
  if (origin) h.set("origin", origin);
  if (cookie) h.set("cookie", cookie);
  if (body !== undefined || raw !== undefined) h.set("content-type", "application/json");
  const init = { method, headers: h };
  if (method !== "GET" && method !== "HEAD") init.body = raw ?? (body === undefined ? undefined : JSON.stringify(body));
  return new Request(`${ORIGIN}${path}${query}`, init);
}
const statusReq = (o = {}) => request("/bff/public/password/status", { method: "GET", ...o });
const forgotReq = (o = {}) => request("/bff/public/password/forgot", { body: { email: EMAIL }, ...o });
const resetReq = (o = {}) => request("/bff/public/password/reset", { body: { token: TOKEN, newPassword: PASSWORD }, ...o });

function noStoreNoCookie(r) {
  assert.equal(r.headers.get("cache-control"), "no-store, private");
  assert.equal(r.headers.getSetCookie().length, 0);
}

// ---------------------------------------------------------------- destino fixo e métodos
test("rotas: destino, método e caminho fixos; fora da allowlist do proxy autenticado", async () => {
  for (const p of ["/auth/forgot-password", "/auth/reset-password", "/auth/password-recovery/status"]) {
    assert.equal(matchAllowlist("POST", p), "not_found");
    assert.equal(matchAllowlist("GET", p), "not_found");
  }
  assert.ok(PROXY_ALLOWLIST.every((r) => !r.path.includes("password")));
  const { bff, calls } = setup(() => jsonRes(200, { available: true }));
  await bff.passwordStatus(statusReq());
  assert.equal(calls[0].url, "http://127.0.0.1:8000/api/v1/auth/password-recovery/status");
  assert.equal(calls[0].init.method, "GET");
  assert.equal(calls[0].init.redirect, "manual");
});

test("métodos indevidos recusados com 405, sem chamar o backend", async () => {
  const { bff, calls } = setup(() => jsonRes(200, {}));
  const cases = [
    [bff.passwordStatus, request("/bff/public/password/status", { method: "POST", body: {} })],
    [bff.passwordForgot, request("/bff/public/password/forgot", { method: "GET" })],
    [bff.passwordReset, request("/bff/public/password/reset", { method: "PUT", body: { token: TOKEN, newPassword: PASSWORD } })],
    [bff.passwordReset, request("/bff/public/password/reset", { method: "DELETE" })],
  ];
  for (const [fn, req] of cases) {
    const r = await fn(req);
    assert.equal(r.status, 405);
    noStoreNoCookie(r);
  }
  assert.equal(calls.length, 0);
});

test("query string não é aceita nem altera o destino", async () => {
  const { bff, calls } = setup(() => jsonRes(200, {}));
  for (const [fn, req] of [[bff.passwordStatus, statusReq({ query: "?path=/admin" })],
    [bff.passwordForgot, forgotReq({ query: "?next=http://evil.example" })],
    [bff.passwordReset, resetReq({ query: "?token=x" })]]) {
    const r = await fn(req);
    assert.equal(r.status, 422);
    noStoreNoCookie(r);
  }
  assert.equal(calls.length, 0);
});

// ---------------------------------------------------------------- CSRF, Origin, corpo
test("CSRF e Origin: cabeçalho próprio sempre; Origin exigida nas mutações", async () => {
  const { bff, calls } = setup(() => jsonRes(200, { available: true }));
  assert.equal((await bff.passwordStatus(statusReq({ csrf: false }))).status, 403);
  assert.equal((await bff.passwordForgot(forgotReq({ csrf: false }))).status, 403);
  assert.equal((await bff.passwordForgot(forgotReq({ origin: "http://evil.example" }))).status, 403);
  assert.equal((await bff.passwordForgot(forgotReq({ origin: null }))).status, 403);
  assert.equal((await bff.passwordReset(resetReq({ origin: "http://evil.example" }))).status, 403);
  assert.equal((await bff.passwordReset(resetReq({ csrf: false }))).status, 403);
  assert.equal(calls.length, 0);
  assert.equal((await bff.passwordStatus(statusReq({ origin: null }))).status, 200);   // GET sem Origin: ok
});

test("corpo exato e entradas inválidas recusados ANTES do backend (422)", async () => {
  const { bff, calls } = setup(() => jsonRes(202, { message: NEUTRAL }));
  const forgotBad = [{}, { email: EMAIL, extra: 1 }, { email: 1 }, { email: "" }, { email: "   " }, { email: "sem-arroba" },
    { email: `${"a".repeat(250)}@x.com` }, { email: "a\u0001b@exemplo.com" }, { Email: EMAIL }];
  for (const body of forgotBad) assert.equal((await bff.passwordForgot(forgotReq({ body }))).status, 422);
  const resetBad = [{}, { token: TOKEN }, { newPassword: PASSWORD }, { token: TOKEN, newPassword: PASSWORD, email: EMAIL },
    { token: "curto", newPassword: PASSWORD }, { token: "x".repeat(257), newPassword: PASSWORD },
    { token: TOKEN, newPassword: "curta" }, { token: TOKEN, newPassword: "x".repeat(129) },
    { token: TOKEN, newPassword: " ".repeat(10) }, { token: 123, newPassword: PASSWORD }, { token: TOKEN, new_password: PASSWORD }];
  for (const body of resetBad) assert.equal((await bff.passwordReset(resetReq({ body }))).status, 422);
  assert.equal((await bff.passwordForgot(forgotReq({ raw: "não é json" }))).status, 422);
  assert.equal((await bff.passwordReset(resetReq({ raw: "[1,2]" }))).status, 422);
  assert.equal((await bff.passwordForgot(forgotReq({ raw: "" }))).status, 422);
  assert.equal(calls.length, 0);
  // limites idênticos aos do backend (subconjunto das recusas dele)
  assert.equal(validateForgotBody({ email: `${"a".repeat(245)}@exemplo.com` }), "E-mail inválido."); // 257 > 254
  assert.equal(validateForgotBody({ email: "  ana@exemplo.com\n" }), null);                       // backend remove espaços externos
  assert.equal(validateResetBody({ token: "x".repeat(16), newPassword: "x".repeat(8) }), null);
  assert.equal(validateResetBody({ token: "x".repeat(256), newPassword: "x".repeat(128) }), null);
  assert.equal(validateResetBody({ token: "x".repeat(16), newPassword: "😀".repeat(128) }), null);   // pontos de código, como no Python
  assert.notEqual(validateResetBody({ token: "x".repeat(16), newPassword: "😀".repeat(129) }), null);
});

test("limite de tamanho do corpo: 413 sem chamar o backend", async () => {
  const { bff, calls } = setup(() => jsonRes(202, { message: NEUTRAL }), { PRAZOAI_BFF_MAX_BODY_BYTES: "1024" });
  const big = JSON.stringify({ email: EMAIL, pad: "x".repeat(4000) });
  const r1 = await bff.passwordForgot(forgotReq({ raw: big }));
  assert.equal(r1.status, 413);
  noStoreNoCookie(r1);
  const r2 = await bff.passwordReset(resetReq({ raw: big, extra: { "content-length": String(big.length) } }));
  assert.equal(r2.status, 413);
  assert.equal(calls.length, 0);
});

// ---------------------------------------------------------------- respostas
test("status: somente { available }, sem informações internas; no-store", async () => {
  const { bff } = setup(() => jsonRes(200, { available: true, transport: "smtp", host: "smtp.interno", queue: 3 }));
  const r = await bff.passwordStatus(statusReq());
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { available: true });
  noStoreNoCookie(r);
  const bad = await setup(() => jsonRes(200, { available: "sim" })).bff.passwordStatus(statusReq());
  assert.equal(bad.status, 503);                                           // forma inesperada: indisponível
});

test("forgot: resposta neutra repassada; recuperação desabilitada (503) preservada; 429 com Retry-After", async () => {
  let r = await setup(() => jsonRes(202, { message: NEUTRAL, debug: "x" })).bff.passwordForgot(forgotReq());
  assert.equal(r.status, 202);
  assert.deepEqual(await r.json(), { message: NEUTRAL });
  noStoreNoCookie(r);
  r = await setup(() => jsonRes(503, { error: { code: "password_recovery_unavailable", message: "Recuperação de senha indisponível no momento." } }))
    .bff.passwordForgot(forgotReq());
  assert.equal(r.status, 503);
  assert.equal((await r.json()).error.code, "password_recovery_unavailable");
  noStoreNoCookie(r);
  r = await setup(() => jsonRes(429, { error: { code: "rate_limited", message: "Muitas solicitações." } }, { "retry-after": "900" }))
    .bff.passwordForgot(forgotReq());
  assert.equal(r.status, 429);
  assert.equal(r.headers.get("retry-after"), "900");
  noStoreNoCookie(r);
});

test("reset: 204 sem corpo e sem login; códigos reais repassados; erros internos sanitizados", async () => {
  let r = await setup(() => new Response(null, { status: 204 })).bff.passwordReset(resetReq());
  assert.equal(r.status, 204);
  assert.equal(await r.text(), "");
  noStoreNoCookie(r);
  for (const [status, code] of [[400, "invalid_reset_token"], [409, "concurrent_update"], [422, "validation_error"], [429, "rate_limited"]]) {
    r = await setup(() => jsonRes(status, { error: { code, message: "Mensagem pública.", details: [{ field: "x" }] } }, { "retry-after": "60" }))
      .bff.passwordReset(resetReq());
    assert.equal(r.status, status);
    assert.deepEqual(await r.json(), { error: { code, message: "Mensagem pública." } });   // sem detalhes
    assert.equal(r.headers.get("retry-after"), status === 429 ? "60" : null);
    noStoreNoCookie(r);
  }
  r = await setup(() => jsonRes(500, { error: { code: "internal_error", message: "smtp.interno:587 falhou" } })).bff.passwordReset(resetReq());
  assert.equal(r.status, 503);
  const text = await r.text();
  check(!text.includes("smtp.interno"), "erro 5xx: sem detalhe interno");
  r = await setup(() => jsonRes(418, { error: { code: "algo_novo", message: "interno" } })).bff.passwordReset(resetReq());
  assert.deepEqual(await r.json(), { error: { code: "upstream_error", message: "Não foi possível concluir." } });
});

// ---------------------------------------------------------------- sessão e cabeçalhos
test("sessão intocada: nenhum acesso ao armazenamento e nenhum cookie em sucesso, erro ou timeout", async () => {
  const handlers = [() => jsonRes(202, { message: NEUTRAL }), () => jsonRes(400, { error: { code: "invalid_reset_token", message: "x" } }),
    () => { const e = new TypeError("x"); e.cause = { code: "ECONNREFUSED" }; throw e; }];
  for (const h of handlers) {
    const { bff, storeCalls } = setup(h);
    for (const r of [await bff.passwordStatus(statusReq()), await bff.passwordForgot(forgotReq()), await bff.passwordReset(resetReq())]) {
      noStoreNoCookie(r);
    }
    assert.deepEqual(storeCalls, []);
  }
});

test("cabeçalhos ao backend montados do zero: sem cookie, Authorization ou X-Forwarded-*; IP só do cabeçalho confiável", async () => {
  const { bff, calls } = setup(() => jsonRes(202, { message: NEUTRAL }));
  const extra = { authorization: "Bearer forjado", "x-forwarded-for": "6.6.6.6", forwarded: "for=6.6.6.6",
    "x-prazoai-client-ip": "6.6.6.6", "x-prazoai-proxy-secret": "forjado", "x-test-client-ip": "203.0.113.7" };
  await bff.passwordForgot(forgotReq({ extra }));
  const sent = calls[0].init.headers;
  assert.equal(sent.cookie, undefined);
  assert.equal(sent.authorization, undefined);
  assert.equal(sent["x-forwarded-for"], undefined);
  assert.equal(sent["x-prazoai-client-ip"], "203.0.113.7");                 // do cabeçalho de infraestrutura
  assert.equal(sent["x-prazoai-proxy-secret"], SECRET);
  const { bff: b2, calls: c2 } = setup(() => jsonRes(202, { message: NEUTRAL }));
  await b2.passwordForgot(forgotReq({ extra: { "x-test-client-ip": "não-é-ip", "x-forwarded-for": "6.6.6.6" } }));
  assert.equal(c2[0].init.headers["x-prazoai-client-ip"], undefined);       // inválido: fallback conservador
});

test("corpo encaminhado exato; logs sem token, senha, e-mail ou corpo", async () => {
  const { bff, calls, logs } = setup(() => new Response(null, { status: 204 }));
  await bff.passwordReset(resetReq());
  assert.ok(JSON.stringify(Object.keys(JSON.parse(calls[0].init.body))) === JSON.stringify(["token", "newPassword"]), "reset: só token e newPassword");
  assert.ok(JSON.parse(calls[0].init.body).token === TOKEN, "reset: token encaminhado no corpo");
  assert.ok(!calls[0].url.includes(TOKEN), "reset: token fora da URL");
  const f = setup(() => { throw Object.assign(new Error("x"), { name: "TimeoutError" }); });
  await f.bff.passwordForgot(forgotReq());
  checkAbsent([...logs, ...f.logs].join("\n"), { token: TOKEN, senha: PASSWORD, email: EMAIL }, "log");
  assert.ok(f.logs.some((l) => l.includes("bff_public_password_uncertain")), "log: categoria do resultado incerto");
});

// ---------------------------------------------------------------- resultado incerto
test("timeout após o envio: 504 outcome unknown, exatamente UM encaminhamento, sem nova tentativa", async () => {
  for (const [fn, req] of [["passwordForgot", forgotReq], ["passwordReset", resetReq]]) {
    let release;
    const gate = new Promise((r) => { release = r; });
    // O dublê "processa" e só responde depois do prazo do BFF: espera o sinal de abort (sem sleep).
    const { bff, calls } = setup((url, init) => new Promise((_, reject) => {
      init.signal.addEventListener("abort", () => { release(); reject(init.signal.reason); }, { once: true });
    }), { PRAZOAI_BFF_TIMEOUT_MS: "100" });
    const r = await bff[fn](req());
    await gate;
    assert.equal(r.status, 504);
    assert.deepEqual(await r.json(), { error: { code: "upstream_timeout", message: "Sem confirmação do servidor; verifique antes de repetir." }, outcome: "unknown" });
    noStoreNoCookie(r);
    assert.equal(calls.length, 1);
  }
  // Leitura (status): incerto vira indisponível; backend fora do ar (não enviado) também.
  const s = await setup(() => { throw Object.assign(new Error("x"), { name: "TimeoutError" }); }).bff.passwordStatus(statusReq());
  assert.equal(s.status, 503);
  const u = setup(() => { const e = new TypeError("x"); e.cause = { code: "ECONNREFUSED" }; throw e; });
  const ur = await u.bff.passwordForgot(forgotReq());
  assert.equal(ur.status, 503);
  assert.equal((await ur.json()).error.code, "backend_unavailable");
  assert.equal(u.calls.length, 1);
});
