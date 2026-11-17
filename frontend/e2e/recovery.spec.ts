// E2E da E5 — recuperação de senha no navegador: Next integrado (BFF) + FastAPI + PostgreSQL +
// Mailpit REAIS. O capturador é lido só pelo harness. Simulações estão marcadas como tal (page.route
// no navegador, para estados que o backend do E2E não produz sob demanda).
import { expect, test } from "./fixtures";
import { PASSWORD, newEmail, signup } from "./helpers";
import {
  MAIL, PUBLIC, T, check, expectNoSetCookie, expectTokenNowhere, expireTokenInDatabase, fakeToken,
  fillNewPassword, freshPassword, loadKit, loginOutcome, messageCount, openLink, recordRequests, requestLinkVia, tokensFor,
} from "./recovery-helpers";

test.describe.configure({ mode: "serial" });
const needsMail = () => test.skip(!MAIL(), "capturador SMTP não configurado (o CI exige: PRAZOAI_REQUIRE_MAILPIT_TESTS=1)");
test.beforeAll(async () => { await loadKit(); });
test.afterAll(async () => { await MAIL()?.deleteAll(); });               // capturador vazio ao final

test("ponta a ponta: pedido → e-mail → link com fragmento → nova senha → antiga recusada → sessões revogadas", async ({ browser }) => {
  needsMail();
  // Sessão EXISTENTE (aba 1) no mesmo navegador em que a recuperação acontece (aba 2).
  const context = await browser.newContext();
  const reqs = recordRequests(context);
  const tab1 = await context.newPage();
  const email = newEmail();
  await signup(tab1, "Rita Recupera", email);
  const tab2 = await context.newPage();

  // 1. pedido pela interface, a partir do login (navegação login → recuperação)
  await tab2.goto("/login");
  await tab2.getByRole("link", { name: "Esqueci minha senha" }).click();
  await expect(tab2.getByRole("button", { name: "Enviar link" })).toBeVisible();
  await requestLinkVia(tab2, email, { open: false });
  check(!(await tab2.getByText(email).count()), "mensagem neutra não ecoa o e-mail");
  // as rotas públicas não tocaram na sessão existente
  await tab1.reload();
  await expect(tab1.getByRole("heading", { name: "Olá, Rita Recupera" })).toBeVisible();

  // 2. mensagem recebida no capturador (lida só pelo harness)
  const [token] = await tokensFor(email, 1);

  // 3–4. abertura do link com fragmento; fragmento removido da barra antes de qualquer envio
  await openLink(tab2, token);
  await expect(tab2.getByRole("button", { name: "Redefinir senha" })).toBeVisible();
  check(new URL(tab2.url()).hash === "" && new URL(tab2.url()).pathname === "/redefinir-senha", "fragmento removido da barra");
  await expectTokenNowhere(tab2, context, token, reqs.all);

  // 5. redefinição pela interface — exatamente um POST
  const newPassword = freshPassword();
  await fillNewPassword(tab2, newPassword);
  await tab2.getByRole("button", { name: "Redefinir senha" }).click();
  await expect(tab2.getByText(T().success)).toBeVisible();
  await expect(tab2.getByRole("link", { name: "Ir para o login" })).toBeVisible();
  check(reqs.to(`${PUBLIC}reset`, "POST").length === 1, "um único envio da redefinição");
  check((await tab2.locator('input[type="password"], input[autocomplete="new-password"]').count()) === 0, "formulário descartado após sucesso");
  await expectTokenNowhere(tab2, context, token, reqs.all);
  await expectNoSetCookie(reqs.all);

  // 6–7. senha antiga recusada; nova aceita (contexto sem sessão)
  const fresh = await browser.newContext();
  const login = await fresh.newPage();
  check((await loginOutcome(login, email, PASSWORD)) === "invalid", "senha antiga recusada");
  check((await loginOutcome(login, email, newPassword)) === "ok", "nova senha aceita");
  await fresh.close();

  // 8. a sessão anterior (aba 1) foi revogada: o uso normal leva ao login
  await tab1.goto("/app/perfil");
  await expect(tab1).toHaveURL(/\/login$/);
  await context.close();
});

test("neutralidade: conta inexistente recebe a mesma resposta e nenhum e-mail", async ({ browser }) => {
  needsMail();
  const owner = await browser.newContext();
  const existing = newEmail();
  await signup(await owner.newPage(), "Sara Existe", existing);
  await owner.close();
  const context = await browser.newContext();
  const page = await context.newPage();
  const missing = newEmail();                                              // nunca cadastrado
  await requestLinkVia(page, missing);
  const textMissing = await page.getByRole("status").first().innerText();
  await page.getByRole("button", { name: "Fazer outro pedido" }).click();
  await requestLinkVia(page, existing, { open: false });
  const textExisting = await page.getByRole("status").first().innerText();
  check(textMissing === textExisting, "mesma resposta para conta existente e inexistente");
  // fila FIFO com um worker: quando a mensagem da conta existente chega, o pedido anterior já foi processado
  await tokensFor(existing, 1);
  check((await messageCount(missing)) === 0, "nenhuma mensagem para conta inexistente");
  await context.close();
});

test("disponibilidade: desabilitada sem formulário; falha de consulta com nova consulta EXPLÍCITA (simulações de rede)", async ({ page }) => {
  // SIMULADO: status { available: false } (o backend do E2E está com a recuperação habilitada).
  await page.route(`**${PUBLIC}status`, (route) => route.fulfill({ status: 200, contentType: "application/json", body: '{"available":false}' }));
  await page.goto("/esqueci-senha");
  await expect(page.getByText(T().disabled)).toBeVisible();
  await expect(page.getByRole("button", { name: "Enviar link" })).toHaveCount(0);
  await page.unroute(`**${PUBLIC}status`);

  // SIMULADO: a primeira consulta falha na rede; nenhuma nova consulta automática.
  let statusCalls = 0;
  await page.route(`**${PUBLIC}status`, async (route) => {
    statusCalls++;
    if (statusCalls === 1) await route.abort("failed"); else await route.continue();
  });
  await page.goto("/esqueci-senha");
  await expect(page.getByText(T().statusError)).toBeVisible();
  check(statusCalls === 1, "sem nova consulta automática");
  await page.getByRole("button", { name: "Verificar novamente" }).click();
  await expect(page.getByRole("button", { name: "Enviar link" })).toBeVisible();
  check(statusCalls === 2, "uma nova consulta, por ação explícita");
});

test("link ausente ou malformado; rota antiga estática, sem eco, sem BFF e com no-referrer", async ({ page, context }) => {
  const reqs = recordRequests(context);
  await page.goto("/redefinir-senha");
  await expect(page.getByText(T().missingLink)).toBeVisible();
  await page.goto("/redefinir-senha#curto!");
  await expect(page.getByText(T().missingLink)).toBeVisible();
  check(new URL(page.url()).hash === "", "fragmento malformado também removido");

  const old = fakeToken();
  let response = null;
  try { response = await page.goto(`/redefinir-senha/${old}`); } catch { /* verificado abaixo */ }
  check(response !== null && response.status() === 200, "página estática da rota antiga");
  check((await response!.allHeaders())["referrer-policy"] === "no-referrer", "Referrer-Policy: no-referrer");
  await expect(page.getByRole("heading", { name: "Link em formato antigo" })).toBeVisible();
  check(!(await page.content()).includes(old), "rota antiga não ecoa o token");
  check(await page.locator('meta[name="referrer"][content="no-referrer"]').count() > 0, "política também no documento");
  await page.getByRole("link", { name: "Pedir novo link" }).hover();       // dispara prefetch, se houver
  const others = reqs.all.filter((r) => r.resourceType() !== "document");
  check(!others.some((r) => r.url().includes(old) || (r.postData() ?? "").includes(old)), "token antigo não sai em outra requisição");
  check(reqs.all.filter((r) => new URL(r.url()).pathname.startsWith(PUBLIC)).length === 0, "nenhuma chamada de recuperação ao BFF");
});

test("recarregar perde o token; senhas divergentes; senha recusada preserva o token para nova tentativa", async ({ browser }) => {
  needsMail();
  const context = await browser.newContext();
  const reqs = recordRequests(context);
  const page = await context.newPage();
  const email = newEmail();
  await signup(page, "Tito Tenta", email);
  await requestLinkVia(page, email);
  const [token] = await tokensFor(email, 1);

  await openLink(page, token);
  await expect(page.getByText(T().memoryOnly)).toBeVisible();     // aviso na própria tela
  await page.reload();                                                     // só vivia em memória
  await expect(page.getByText(T().missingLink)).toBeVisible();

  await openLink(page, token);                                             // reabrir o link do e-mail
  const newPassword = freshPassword();
  await fillNewPassword(page, newPassword, `${newPassword}x`);
  await page.getByRole("button", { name: "Redefinir senha" }).click();
  await expect(page.getByText(T().mismatch)).toBeVisible();
  check(reqs.to(`${PUBLIC}reset`, "POST").length === 0, "divergência não envia nada");

  // SIMULADO: o BFF recusa a senha (422). A tela mantém o token para nova tentativa explícita.
  let calls = 0;
  await page.route(`**${PUBLIC}reset`, async (route) => {
    calls++;
    if (calls === 1) await route.fulfill({ status: 422, contentType: "application/json", body: '{"error":{"code":"validation_error","message":"x"}}' });
    else await route.continue();
  });
  await fillNewPassword(page, newPassword);
  await page.getByRole("button", { name: "Redefinir senha" }).click();
  await expect(page.getByText(T().passwordRejected)).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Nova senha", exact: true })).toBeFocused();
  check(calls === 1, "nenhuma repetição automática");
  await page.getByRole("button", { name: "Redefinir senha" }).click();    // nova tentativa EXPLÍCITA, mesmo token
  await expect(page.getByText(T().success)).toBeVisible();
  check(calls === 2, "duas tentativas, ambas explícitas");
  await expectTokenNowhere(page, context, token, reqs.all);
  await context.close();
});

test("link substituído, usado e expirado: a mesma mensagem, sem distinguir", async ({ browser }) => {
  needsMail();
  const context = await browser.newContext();
  const page = await context.newPage();
  const email = newEmail();
  await signup(page, "Ugo Usa", email);
  await requestLinkVia(page, email);
  await page.getByRole("button", { name: "Fazer outro pedido" }).click();
  await requestLinkVia(page, email, { open: false });
  const [first, second] = await tokensFor(email, 2);                     // chegada em ordem (um worker, FIFO)

  const attempt = async (token: string) => {
    await openLink(page, token);
    await fillNewPassword(page, freshPassword());
    await page.getByRole("button", { name: "Redefinir senha" }).click();
  };
  await attempt(first);                                                    // substituído pelo segundo pedido
  await expect(page.getByText(T().invalidLink)).toBeVisible();
  await attempt(second);
  await expect(page.getByText(T().success)).toBeVisible();
  await attempt(second);                                                   // já usado
  await expect(page.getByText(T().invalidLink)).toBeVisible();

  // expiração: fixture no banco descartável, sem esperar o TTL real (só PostgreSQL)
  test.skip(process.env.STORAGE !== "postgres", "expiração exige o PostgreSQL do E2E");
  const other = newEmail();
  const evaContext = await browser.newContext();
  const eva = await evaContext.newPage();
  await signup(eva, "Eva Expira", other);
  await requestLinkVia(eva, other);
  const [toExpire] = await tokensFor(other, 1);
  expireTokenInDatabase(toExpire);
  await attempt(toExpire);                                                 // aberto na aba do Ugo (sem relação com a sessão)
  await expect(page.getByText(T().invalidLink)).toBeVisible();
  await evaContext.close();
  await context.close();
});

test("limites: pedido e redefinição respeitam Retry-After, sem repetição automática", async ({ page, context }) => {
  const reqs = recordRequests(context);
  const email = newEmail();                                                // inexistente: o limite por e-mail conta igual
  await page.goto("/esqueci-senha");
  for (let i = 0; i < 3; i++) {
    await requestLinkVia(page, email, { open: false });
    await page.getByRole("button", { name: "Fazer outro pedido" }).click();
  }
  await page.getByLabel("E-mail").fill(email);
  await page.getByRole("button", { name: "Enviar link" }).click();
  await expect(page.getByRole("heading", { name: "Muitas solicitações" })).toBeVisible();
  const forgot = reqs.to(`${PUBLIC}forgot`, "POST");
  check(forgot.length === 4, "quatro envios, todos explícitos");
  const retryAfter = (await (await forgot[3].response())!.allHeaders())["retry-after"];
  check(/^\d+$/.test(retryAfter ?? ""), "Retry-After presente");
  await expect(page.getByText(`Aguarde ${retryAfter} segundo`)).toBeVisible();
  await expect(page.getByRole("button", { name: "Aguarde para tentar novamente" })).toBeDisabled();

  // redefinição: 10 tentativas inválidas pelo MESMO cliente de rede (harness), a 11ª pela interface
  for (let i = 0; i < 10; i++) {
    const r = await context.request.post(`${PUBLIC}reset`, {
      headers: { "x-prazoai-csrf": "1", origin: new URL(page.url()).origin },
      data: { token: fakeToken(), newPassword: freshPassword() },
    });
    check(r.status() === 400, "tentativa inválida recusada pelo backend");
  }
  await openLink(page, fakeToken());
  await fillNewPassword(page, freshPassword());
  await page.getByRole("button", { name: "Redefinir senha" }).click();
  await expect(page.getByRole("heading", { name: "Muitas tentativas" })).toBeVisible();
  const resets = reqs.to(`${PUBLIC}reset`, "POST");
  check(resets.length === 1, "um único envio pela interface");
  const resetRetry = (await (await resets[0].response())!.allHeaders())["retry-after"];
  await expect(page.getByText(`Aguarde ${resetRetry} segundo`)).toBeVisible();
  await expect(page.getByRole("button", { name: "Aguarde para tentar novamente" })).toBeDisabled();
});

test("falha de rede e resultado desconhecido: exatamente um envio, sem afirmar falha", async ({ browser }) => {
  needsMail();
  const context = await browser.newContext();
  const page = await context.newPage();
  const email = newEmail();
  await signup(page, "Nina Rede", email);

  // SIMULADO: o pedido nunca chega (falha de rede no navegador) → resultado não confirmado.
  let forgotCalls = 0;
  await page.route(`**${PUBLIC}forgot`, async (route) => { forgotCalls++; await route.abort("failed"); });
  await page.goto("/esqueci-senha");
  await page.getByLabel("E-mail").fill(email);
  await page.getByRole("button", { name: "Enviar link" }).click();
  await expect(page.getByText(T().forgotUnknown)).toBeVisible();
  check(forgotCalls === 1, "um único envio do pedido");
  await page.unroute(`**${PUBLIC}forgot`);
  await page.getByRole("button", { name: "Voltar ao formulário" }).click();
  await requestLinkVia(page, email, { open: false });                     // novo pedido, explícito
  const [token] = await tokensFor(email, 1);

  // A redefinição É PROCESSADA pelo servidor, mas a resposta se perde (padrão dos demais E2E).
  let resetCalls = 0;
  await page.route(`**${PUBLIC}reset`, async (route) => {
    resetCalls++;
    await route.fetch();                                                  // o servidor redefine…
    await route.abort("connectionreset");                                 // …e a resposta não chega
  });
  await openLink(page, token);
  const newPassword = freshPassword();
  await fillNewPassword(page, newPassword);
  await page.getByRole("button", { name: "Redefinir senha" }).click();
  await expect(page.getByText(T().resetUnknown)).toBeVisible();
  check(resetCalls === 1, "um único envio da redefinição");
  // conferência sugerida pela tela: entrar com a NOVA senha
  await page.getByRole("link", { name: "Conferir entrando com a nova senha" }).click();
  check((await loginOutcome(page, email, newPassword)) === "ok", "a redefinição tinha sido concluída");
  check(resetCalls === 1, "nenhum reenvio");
  await context.close();
});

test("rotas públicas preservam a sessão existente", async ({ page, context }) => {
  const reqs = recordRequests(context);
  const email = newEmail();
  await signup(page, "Olga Sessão", email);
  const before = (await context.cookies()).map((c) => c.name).sort();
  const tab = await context.newPage();
  await tab.goto("/esqueci-senha");
  await expect(tab.getByRole("button", { name: "Enviar link" })).toBeVisible();
  await requestLinkVia(tab, newEmail(), { open: false });
  await openLink(tab, fakeToken());
  await fillNewPassword(tab, freshPassword());
  await tab.getByRole("button", { name: "Redefinir senha" }).click();
  await expect(tab.getByText(T().invalidLink)).toBeVisible();
  await expectNoSetCookie(reqs.all);
  const publicCalls = reqs.all.filter((r) => new URL(r.url()).pathname.startsWith(PUBLIC));
  check(publicCalls.length === 3, "status, pedido e redefinição");
  check(JSON.stringify((await context.cookies()).map((c) => c.name).sort()) === JSON.stringify(before), "mesmos cookies");
  await page.goto("/app/perfil");
  await expect(page.getByLabel("E-mail")).toHaveValue(email);              // sessão continua válida
});
