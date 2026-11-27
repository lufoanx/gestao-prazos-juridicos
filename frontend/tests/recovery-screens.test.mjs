// E5 — unitários das peças das telas de recuperação: regras compartilhadas, captura do fragmento,
// cliente público, classificação de erros e transições de estado. Sem React e sem rede.
import test from "node:test";
import assert from "node:assert/strict";
import { ApiError, createApiClient } from "../src/lib/integration/api-client.mjs";
import { createFragmentTokenHolder, captureFragmentToken, parseFragmentToken } from "../src/lib/integration/fragment-token.mjs";
import { captureInviteToken, parseInviteFragment } from "../src/lib/integration/invite-token.mjs";
import { RECOVERY_PATHS, createRecoveryClient } from "../src/lib/integration/recovery-client.mjs";
import { createResetController } from "../src/lib/integration/reset-controller.mjs";
import {
  FORGOT_INITIAL, RECOVERY_TEXT, RESET_INITIAL, checkForgotForm, checkResetForm, classifyForgotError, classifyResetError,
  createSingleFlight, forgotReducer, parseRetryAfter, rateLimitText, resetReducer,
} from "../src/lib/integration/recovery-flow.mjs";
import { emailProblem, passwordProblem, validateForgotBody, validateResetBody } from "../src/lib/integration/recovery-rules.mjs";
import { routeDecision } from "../src/lib/integration/routes.mjs";
import * as bff from "../src/server/bff/public-recovery.mjs";
import { check, checkAbsent } from "./helpers/sensitive.mjs";

const TOKEN = "R".repeat(20) + "_-" + "x".repeat(21);           // fictício, forma base64url (43)
const PASSWORD = "Nova-senha-ficticia-1";
const json = (status, body, headers = {}) => new Response(body === null ? null : JSON.stringify(body), {
  status, headers: { "content-type": "application/json", ...headers },
});
const fakeWin = (hash, pathname = "/redefinir-senha") => {
  const calls = [];
  const win = { location: { hash, pathname }, history: { replaceState: (...a) => { calls.push(a); win.location.hash = ""; } } };
  return { win, calls };
};
const apiError = (status, code, extra) => new ApiError(status, code, "x", extra);

// ------------------------------------------------------------------------------------- regras
test("regras: BFF e telas usam as MESMAS funções (sem duplicação de limites)", () => {
  assert.equal(bff.validateForgotBody, validateForgotBody);
  assert.equal(bff.validateResetBody, validateResetBody);
  assert.equal(emailProblem(" a@b "), null);                          // espaços externos: o backend remove
  assert.ok(emailProblem("sem-arroba"));
  assert.ok(emailProblem(`${"a".repeat(250)}@b.co`));                 // 255 pontos de código
  assert.equal(passwordProblem("😀".repeat(8)), null);                 // 8 pontos de código (16 unidades UTF-16)
  assert.ok(passwordProblem("😀".repeat(129)));
  assert.ok(passwordProblem("        "));                             // só espaços
  assert.deepEqual(checkForgotForm("x"), { email: "Informe um e-mail válido." });
  assert.deepEqual(checkResetForm({ password: PASSWORD, confirm: PASSWORD }), {});
  assert.deepEqual(Object.keys(checkResetForm({ password: PASSWORD, confirm: "outra-senha-1" })), ["confirm"]);
  assert.deepEqual(Object.keys(checkResetForm({ password: "curta", confirm: "curta" })), ["password"]);
});

// ----------------------------------------------------------------------------------- fragmento
test("fragmento: lido, removido da barra (também malformado) e sem query/pathname com token", () => {
  assert.equal(parseFragmentToken(`#${TOKEN}`), TOKEN);
  for (const bad of ["", "#", "#curto", `#${TOKEN}/x`, `#${TOKEN}?a=1`, `#${"a".repeat(257)}`, TOKEN]) {
    assert.equal(parseFragmentToken(bad), null);
  }
  let { win, calls } = fakeWin(`#${TOKEN}`);
  check(captureFragmentToken(win) === TOKEN, "token capturado");
  assert.deepEqual(calls, [[null, "", "/redefinir-senha"]]);
  ({ win, calls } = fakeWin("#malformado!"));
  assert.equal(captureFragmentToken(win), null);
  assert.deepEqual(calls, [[null, "", "/redefinir-senha"]]);          // removido mesmo assim
  ({ win, calls } = fakeWin(""));
  assert.equal(captureFragmentToken(win), null);
  assert.deepEqual(calls, []);                                         // nada a limpar
  // convites continuam com o mesmo comportamento (agora pela mesma função)
  assert.equal(parseInviteFragment, parseFragmentToken);
  assert.equal(captureInviteToken, captureFragmentToken);
});

test("fragmento: captura idempotente sob efeitos repetidos (StrictMode) e novo link na mesma aba", () => {
  const holder = createFragmentTokenHolder();
  const { win, calls } = fakeWin(`#${TOKEN}`);
  const first = holder.capture(win);                                   // efeito
  const again = holder.capture(win);                                   // efeito repetido: barra já limpa
  check(first.token === TOKEN && first.fresh, "primeira leitura");
  check(again.token === TOKEN && !again.fresh, "repetição devolve o mesmo token sem reler");
  assert.equal(calls.length, 1);                                       // uma só limpeza
  const NEW = "N".repeat(43);
  win.location.hash = `#${NEW}`;                                       // outro link aberto na aba (hashchange)
  check(holder.capture(win).token === NEW, "novo link substitui o anterior");
  assert.equal(calls.length, 2);
  check(holder.revision === 2, "uma revisão por leitura nova");
  check(holder.clear(1) === false && holder.token === NEW, "descarte de captura antiga não apaga o link novo");
  check(holder.clear(2) === true, "descarte da captura atual");
  assert.equal(holder.token, null);
  assert.equal(holder.capture(win).token, null);                       // descartado não volta
});

// -------------------------------------------------------------------------------------- cliente
test("cliente público: só as rotas públicas do BFF; token e senha só no corpo; CSRF; sem query", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith("/status")) return json(200, { available: true, transport: "smtp" });
    if (url.endsWith("/forgot")) return json(202, { message: "neutra" });
    return new Response(null, { status: 204 });
  };
  const client = createRecoveryClient({ api: createApiClient({ fetchImpl }) });
  assert.deepEqual(await client.status(), { available: true });        // só o booleano
  await client.forgot("pessoa@exemplo.com");
  assert.equal(await client.reset(TOKEN, PASSWORD), null);
  assert.deepEqual(calls.map((c) => [c.init.method, c.url]), [
    ["GET", RECOVERY_PATHS.status], ["POST", RECOVERY_PATHS.forgot], ["POST", RECOVERY_PATHS.reset],
  ]);
  for (const c of calls) {
    assert.equal(c.init.headers["x-prazoai-csrf"], "1");
    assert.equal(c.init.cache, "no-store");
    assert.equal(c.init.credentials, "same-origin");
    checkAbsent(c.url, { token: TOKEN, senha: PASSWORD }, "URL da requisição");
    check(!c.url.includes("?"), "sem query");
  }
  check(JSON.parse(calls[2].init.body).token === TOKEN, "token no corpo");
  assert.deepEqual(Object.keys(JSON.parse(calls[2].init.body)), ["token", "newPassword"]);
  // forma inesperada do status → erro (a tela mostra falha de consulta, nunca "disponível")
  const odd = createRecoveryClient({ api: createApiClient({ fetchImpl: async () => json(200, { ok: 1 }) }) });
  await assert.rejects(odd.status());
});

test("cliente público: instância própria — trocar a época da SESSÃO não aborta a redefinição", async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const fetchImpl = async (_url, init) => {
    await gate;
    if (init.signal.aborted) throw new DOMException("aborted", "AbortError");
    return new Response(null, { status: 204 });
  };
  const session = createApiClient({ fetchImpl });
  const client = createRecoveryClient({ api: createApiClient({ fetchImpl }) });
  const pending = client.reset(TOKEN, PASSWORD);
  session.bumpEpoch();                                                 // login/logout em outra parte da app
  release();
  assert.equal(await pending, null);
});

// ------------------------------------------------------------------------------- classificação
test("classificação do pedido: desabilitada, limite, desconhecido, validação, indisponível", () => {
  assert.deepEqual(classifyForgotError(apiError(503, "password_recovery_unavailable")), { phase: "disabled" });
  assert.deepEqual(classifyForgotError(apiError(429, "rate_limited", { retryAfter: "120" })), { phase: "rate_limited", retryAfter: 120 });
  assert.deepEqual(classifyForgotError(apiError(429, "rate_limited", { retryAfter: "amanhã" })), { phase: "rate_limited", retryAfter: null });
  assert.deepEqual(classifyForgotError(apiError(504, "upstream_timeout", { outcome: "unknown" })), { phase: "unknown" });
  assert.deepEqual(classifyForgotError(apiError(0, "network_error")), { phase: "unknown" });     // pode ter chegado
  assert.equal(classifyForgotError(apiError(422, "validation_error")).field, "email");
  assert.equal(classifyForgotError(apiError(503, "backend_unavailable")).error, RECOVERY_TEXT.unavailable);
  assert.equal(classifyForgotError(new Error("x")).phase, "form");
});

test("classificação da redefinição: link inválido descarta o token; senha recusada preserva", () => {
  assert.deepEqual(classifyResetError(apiError(400, "invalid_reset_token")), { phase: "invalid_link", dropToken: true });
  const weak = classifyResetError(apiError(422, "validation_error"));
  assert.deepEqual([weak.phase, weak.field, weak.dropToken], ["form", "password", undefined]);
  assert.deepEqual(classifyResetError(apiError(504, "upstream_timeout", { outcome: "unknown" })), { phase: "unknown" });
  assert.deepEqual(classifyResetError(apiError(0, "network_error")), { phase: "unknown" });
  assert.deepEqual(classifyResetError(apiError(429, "rate_limited", { retryAfter: "60" })), { phase: "rate_limited", retryAfter: 60 });
  assert.equal(classifyResetError(apiError(409, "concurrent_update")).error, RECOVERY_TEXT.concurrent);
  assert.equal(classifyResetError(apiError(503, "backend_unavailable")).phase, "form");
  assert.equal(parseRetryAfter("0"), null);
  assert.equal(parseRetryAfter("86401"), null);
  assert.match(rateLimitText(1), /1 segundo antes/);
  assert.match(rateLimitText(null), /alguns minutos/);
});

test("textos: neutros (nunca 'e-mail enviado') e sem afirmar falha no resultado desconhecido", () => {
  assert.ok(!/enviado|enviamos o|existe/i.test(RECOVERY_TEXT.accepted), "aceite neutro");
  assert.ok(/Se houver uma conta/.test(RECOVERY_TEXT.accepted), "texto do aceite");
  assert.ok(!/falhou|não foi redefinida/i.test(RECOVERY_TEXT.resetUnknown), "desconhecido não afirma falha");
  assert.ok(/NOVA senha/.test(RECOVERY_TEXT.resetUnknown), "explica como conferir");
});

// ------------------------------------------------------------------------------------ transições
test("pedido: um envio por vez; nada repete sozinho; espera do Retry-After antes de liberar", () => {
  let s = forgotReducer(FORGOT_INITIAL, { type: "status", available: true });
  assert.equal(s.phase, "form");
  s = forgotReducer(s, { type: "submit" });
  assert.equal(forgotReducer(s, { type: "submit" }), s);               // segundo clique ignorado
  assert.equal(forgotReducer(s, { type: "edit" }), s);                 // não sai de "enviando"
  const unknown = forgotReducer(s, { type: "failed", outcome: { phase: "unknown" } });
  assert.equal(unknown.phase, "unknown");
  assert.equal(forgotReducer(unknown, { type: "submit" }), unknown);    // nenhuma repetição sem ação explícita
  assert.equal(forgotReducer(unknown, { type: "edit" }).phase, "form");
  let rl = forgotReducer({ phase: "sending" }, { type: "failed", outcome: { phase: "rate_limited", retryAfter: 30 } });
  assert.deepEqual(rl, { phase: "rate_limited", retryAfter: 30, waiting: true });
  assert.equal(forgotReducer(rl, { type: "edit" }), rl);                // ainda dentro do Retry-After
  rl = forgotReducer(rl, { type: "cooldown", waiting: false });
  assert.equal(forgotReducer(rl, { type: "edit" }).phase, "form");
  assert.equal(forgotReducer({ phase: "sending" }, { type: "accepted" }).phase, "accepted");
  assert.equal(forgotReducer({ phase: "form" }, { type: "accepted" }).phase, "form");   // aceite sem envio: ignorado
  assert.equal(forgotReducer(FORGOT_INITIAL, { type: "status", available: false }).phase, "disabled");
  const failed = forgotReducer(FORGOT_INITIAL, { type: "status_failed" });
  assert.equal(failed.phase, "status_error");
  assert.equal(forgotReducer(failed, { type: "check" }).phase, "checking");   // nova consulta explícita
});

test("redefinição: leitura, envio único, sucesso só depois do envio, link inválido terminal", () => {
  assert.equal(resetReducer(RESET_INITIAL, { type: "captured", hasToken: false }).phase, "missing");
  let s = resetReducer(RESET_INITIAL, { type: "captured", hasToken: true });
  assert.equal(s.phase, "form");
  s = resetReducer(s, { type: "submit" });
  assert.equal(resetReducer(s, { type: "submit" }), s);
  const waiting = resetReducer(s, { type: "captured", hasToken: true });       // novo link durante o envio
  assert.deepEqual(waiting, { phase: "waiting_previous", hasToken: true });
  assert.equal(resetReducer(waiting, { type: "success" }), waiting);           // resposta antiga não vale para o novo link
  assert.equal(resetReducer(waiting, { type: "failed", outcome: { phase: "invalid_link" } }), waiting);
  assert.equal(resetReducer(waiting, { type: "submit" }), waiting);
  assert.equal(resetReducer(waiting, { type: "edit" }), waiting);
  assert.deepEqual(resetReducer(waiting, { type: "settled_stale" }), { phase: "form", notice: "replaced" });
  assert.deepEqual(resetReducer({ phase: "waiting_previous", hasToken: false }, { type: "settled_stale" }), { phase: "missing" });
  assert.equal(resetReducer(s, { type: "success" }).phase, "success");
  assert.equal(resetReducer({ phase: "form" }, { type: "success" }).phase, "form");
  const weak = resetReducer(s, { type: "failed", outcome: { phase: "form", error: "x", field: "password" } });
  assert.deepEqual([weak.phase, weak.field], ["form", "password"]);
  const invalid = resetReducer(s, { type: "failed", outcome: { phase: "invalid_link", dropToken: true } });
  assert.equal(resetReducer(invalid, { type: "edit" }), invalid);             // sem token: só pedir outro link
  const unknown = resetReducer(s, { type: "failed", outcome: { phase: "unknown" } });
  assert.equal(resetReducer(unknown, { type: "submit" }), unknown);
  assert.equal(resetReducer(unknown, { type: "edit" }).phase, "form");
});

test("envio único: dois cliques simultâneos → uma chamada", async () => {
  const flight = createSingleFlight();
  let calls = 0;
  let release;
  const gate = new Promise((r) => { release = r; });
  const a = flight.run(async () => { calls++; await gate; return 1; });
  const b = await flight.run(async () => { calls++; return 2; });
  assert.deepEqual(b, { started: false });
  release();
  assert.deepEqual(await a, { started: true, value: 1 });
  assert.equal(calls, 1);
  assert.equal(flight.busy, false);
  const failed = await flight.run(async () => { throw new Error("x"); });
  assert.ok(failed.started && failed.error instanceof Error);
});

// ------------------------------------------------------------------------------------- rotas
test("rotas: formato antigo /redefinir-senha/<token> nunca chega a uma página que o leia (dois modos)", () => {
  for (const mode of ["demo", "integrated"]) {
    for (const path of [`/redefinir-senha/${TOKEN}`, "/redefinir-senha/demo", "/redefinir-senha/a/b"]) {
      const d = routeDecision(path, mode);
      check(d.action === "rewrite" && d.to === "/redefinir-senha-antigo" && d.noReferrer === true, `rota antiga (${mode})`);
    }
    assert.deepEqual(routeDecision("/redefinir-senha", mode), { action: "allow", noReferrer: true });
    assert.deepEqual(routeDecision("/redefinir-senha-antigo", mode), { action: "allow", noReferrer: true });
    assert.equal(routeDecision("/esqueci-senha", mode).action, "allow");
  }
});

// ------------------------------------------------------------------- coordenação completa (§23)
// Controlador real (captura + estado + envio único + resposta), com cliente dublê e gates.
const TOKEN_A = "A".repeat(43);
const TOKEN_B = "B".repeat(20) + "-_" + "b".repeat(21);
const winAt = (hash) => {
  const win = { location: { hash, pathname: "/redefinir-senha" }, history: { calls: 0, replaceState() { win.history.calls++; win.location.hash = ""; } } };
  return win;
};
function gatedClient() {
  const calls = [];
  return {
    calls,
    reset(token, newPassword) {
      let settle;
      const p = new Promise((resolve, reject) => { settle = { resolve, reject }; });
      calls.push({ token, newPassword, settle });
      return p;
    },
  };
}
const flush = () => new Promise((r) => setImmediate(r));
const outcomes = {
  invalid: (s) => s.reject(apiError(400, "invalid_reset_token")),
  success: (s) => s.resolve(null),
  rate_limited: (s) => s.reject(apiError(429, "rate_limited", { retryAfter: "60" })),
  unknown: (s) => s.reject(apiError(504, "upstream_timeout", { outcome: "unknown" })),
  network: (s) => s.reject(apiError(0, "network_error")),
  weak: (s) => s.reject(apiError(422, "validation_error")),
};

for (const [name, finish] of Object.entries(outcomes)) {
  test(`coordenação: resposta "${name}" de A liberada depois da captura de B não apaga nem substitui B`, async () => {
    const win = winAt(`#${TOKEN_A}`);
    const client = gatedClient();
    const ctl = createResetController({ client, getWindow: () => win });
    ctl.read();
    ctl.read();                                                          // efeito repetido (StrictMode)
    check(win.history.calls === 1 && ctl.snapshot.state.phase === "form", "captura idempotente de A");
    ctl.setPassword(PASSWORD); ctl.setConfirm(PASSWORD);
    const pending = ctl.submit();                                        // A sai e fica retida
    await flush();
    check(client.calls.length === 1 && client.calls[0].token === TOKEN_A, "A enviada com o token de A");

    win.location.hash = `#${TOKEN_B}`;                                   // hashchange: novo link
    ctl.read();
    check(win.location.hash === "", "fragmento novo removido imediatamente");
    assert.deepEqual(ctl.snapshot.state, { phase: "waiting_previous", hasToken: true });
    check(ctl.snapshot.password === "" && ctl.snapshot.confirm === "", "senhas de A descartadas ao aceitar B");
    await ctl.submit();                                                  // clique ignorado? não há botão; e nada sai
    check(client.calls.length === 1, "nada enviado enquanto A termina");

    finish(client.calls[0].settle);                                      // libera a resposta antiga
    await pending;
    assert.deepEqual(ctl.snapshot.state, { phase: "form", notice: "replaced" });   // nem sucesso, nem erro de A
    check(client.calls.length === 1, "nenhum envio automático com B");
    check(!JSON.stringify(ctl.snapshot).includes(TOKEN_B), "token fora do estado renderizável");

    ctl.setPassword("Senha-de-B-123"); ctl.setConfirm("Senha-de-B-123");
    const sendB = ctl.submit();                                          // ação EXPLÍCITA
    await flush();
    check(client.calls.length === 2 && client.calls[1].token === TOKEN_B, "B utilizável sem reabrir o link");
    client.calls[1].settle.resolve(null);
    await sendB;
    assert.equal(ctl.snapshot.state.phase, "success");
    check(ctl.snapshot.password === "" && ctl.snapshot.confirm === "", "senhas descartadas após sucesso");
    await ctl.submit();
    check(client.calls.length === 2, "nenhuma repetição depois do sucesso");
  });
}

test("coordenação: novo link MALFORMADO durante o envio → após A, link incompleto (sem herdar A)", async () => {
  const win = winAt(`#${TOKEN_A}`);
  const client = gatedClient();
  const ctl = createResetController({ client, getWindow: () => win });
  ctl.read(); ctl.setPassword(PASSWORD); ctl.setConfirm(PASSWORD);
  const pending = ctl.submit();
  await flush();
  win.location.hash = "#quebrado!";
  ctl.read();
  check(win.location.hash === "", "malformado também removido");
  client.calls[0].settle.resolve(null);                                  // A teve sucesso no servidor…
  await pending;
  assert.deepEqual(ctl.snapshot.state, { phase: "missing" });            // …mas a tela é a do link novo (incompleto)
  await ctl.submit();
  check(client.calls.length === 1, "nada enviado sem token");
});

test("coordenação: sem corrida, o resultado é da própria captura (sucesso descarta; link inválido descarta; senha recusada preserva)", async () => {
  for (const [finish, phase, kept] of [["success", "success", false], ["invalid", "invalid_link", false], ["weak", "form", true]]) {
    const win = winAt(`#${TOKEN_A}`);
    const client = gatedClient();
    const ctl = createResetController({ client, getWindow: () => win });
    ctl.read(); ctl.setPassword(PASSWORD); ctl.setConfirm(PASSWORD);
    const p = ctl.submit();
    await flush();
    outcomes[finish](client.calls[0].settle);
    await p;
    assert.equal(ctl.snapshot.state.phase, phase);
    ctl.setPassword(PASSWORD); ctl.setConfirm(PASSWORD);
    const again = ctl.submit();
    await flush();
    if (kept) {
      check(client.calls.length === 2 && client.calls[1].token === TOKEN_A, "token preservado para nova tentativa explícita");
      client.calls[1].settle.resolve(null);
      await again;
    } else {
      await again;
      check(client.calls.length === 1, "token descartado: nenhuma nova tentativa possível");
    }
  }
});

test("coordenação: recarregar (nova instância, sem fragmento) perde o token", () => {
  const win = winAt(`#${TOKEN_A}`);
  createResetController({ client: gatedClient(), getWindow: () => win }).read();
  const after = createResetController({ client: gatedClient(), getWindow: () => win });   // a barra já está limpa
  after.read();
  assert.deepEqual(after.snapshot.state, { phase: "missing" });
});
