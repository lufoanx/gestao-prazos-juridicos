// E2E 6.2 — onboarding, ambientes, escritório, equipe, convites e solicitações.
// Navegador real + Next (build integrado) + FastAPI real. Usuários diferentes = CONTEXTOS diferentes;
// abas do mesmo contexto compartilham a sessão.
import { type Browser, type Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { PASSWORD, logout, newEmail, signupToOnboarding } from "./helpers";

test.describe.configure({ mode: "serial" });
const BACKEND = `http://127.0.0.1:${Number(process.env.PRAZOAI_E2E_BACKEND_PORT || 18900) + 1}`;
const DEMO_TEXTS = ["Contestação — locação residencial", "Paula Andrade", "Rafael Neves"];

async function person(browser: Browser, name: string) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const email = newEmail();
  await signupToOnboarding(page, name, email);
  return { context, page, email, name };
}

async function createOffice(page: Page, officeName: string) {
  await page.getByLabel("Nome do escritório").fill(officeName);
  await page.getByRole("button", { name: "Criar escritório" }).click();
  await expect(page).toHaveURL(/\/app\/escritorio$/);
  await expect(page.getByRole("heading", { name: officeName })).toBeVisible();
}

async function newInviteLink(page: Page) {
  await page.goto("/app/escritorio");
  await page.getByRole("button", { name: "Gerar link de convite" }).click();
  const field = page.getByLabel("Link do convite (exibido só agora)");
  await expect(field).toBeVisible();
  return field.inputValue();
}

/** Registra toda URL de requisição (para provar que o token nunca aparece nelas). */
function recordUrls(page: Page) {
  const urls: string[] = [];
  page.on("request", (r) => urls.push(r.url()));
  return urls;
}

/** Responsabilidade em aberto criada pela API EXISTENTE do backend (fixture), não pelo BFF. */
async function createDeadlineFor(adminEmail: string, responsibleId: string) {
  const login = await fetch(`${BACKEND}/api/v1/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: adminEmail, password: PASSWORD }) });
  const { accessToken } = await login.json();
  const r = await fetch(`${BACKEND}/api/v1/deadlines`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ scope: "office", title: "Contestação", caseNumber: "0001234-56.2026", court: "TJSC", practiceArea: "Cível",
      startDate: "2026-11-09", dueDate: "2026-11-20", countingMode: "business", duration: 10, responsibleId }) });
  expect(r.status).toBe(201);
}

async function userIdOf(page: Page) {
  return page.evaluate(async () => (await (await fetch("/bff/session", { headers: { "x-prazoai-csrf": "1" } })).json()).user.id);
}

test("onboarding: criar escritório, bloquear segundo e alternar ambientes sem misturar dados", async ({ browser }) => {
  const ana = await person(browser, "Ana Sócia");
  await createOffice(ana.page, "Silva Advocacia");
  await ana.page.goto("/onboarding");
  await expect(ana.page.getByRole("heading", { name: "Você já pertence a um escritório" })).toBeVisible();
  await ana.page.goto("/app");
  const env = ana.page.getByLabel("Ambiente");
  await expect(env).toHaveValue("office");
  await env.selectOption("personal");
  await expect(ana.page.getByRole("heading", { name: "Ambiente pessoal" })).toBeVisible();
  await ana.page.goto("/app/escritorio");                        // navegação não é autorização, mas respeita o ambiente
  await expect(ana.page.getByText("Você está no ambiente pessoal")).toBeVisible();
  for (const t of DEMO_TEXTS) await expect(ana.page.getByText(t)).toHaveCount(0);
  await ana.context.close();
});

test("convite: link com fragmento, autenticação na própria tela, confirmação e token fora de URLs/storage", async ({ browser }) => {
  const ana = await person(browser, "Ana Convida");
  await createOffice(ana.page, "Convites & Cia");
  const link = await newInviteLink(ana.page);
  expect(link).toMatch(/\/convite#[A-Za-z0-9_-]{16,}$/);
  const token = link.split("#")[1];
  await expect(ana.page.getByText("Nenhum e-mail é enviado")).toBeVisible();

  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const urls = recordUrls(page);
  await page.goto(link);
  await expect(page.getByText("Convite válido")).toBeVisible();
  await expect(page.getByText("Escritório: Convites & Cia")).toBeVisible();
  expect(page.url()).not.toContain("#");                          // fragmento removido da barra
  await page.getByRole("tab", { name: "Criar conta" }).click();   // autentica sem sair da tela
  const email = newEmail();
  await page.getByLabel("Nome").fill("Bia Convidada");
  await page.getByLabel("E-mail").fill(email);
  const pw = page.locator('input[autocomplete="new-password"]');
  await pw.nth(0).fill(PASSWORD);
  await pw.nth(1).fill(PASSWORD);
  await page.getByRole("button", { name: "Criar conta", exact: true }).click();
  await page.getByRole("button", { name: "Aceitar convite" }).click();
  await page.getByRole("button", { name: "Aceitar e entrar" }).click();   // confirmação explícita
  await expect(page).toHaveURL(/\/app\/escritorio$/);
  await expect(page.getByRole("heading", { name: "Convites & Cia" })).toBeVisible();
  expect(urls.some((u) => u.includes(token))).toBe(false);
  const storage = await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }));
  expect(storage).not.toContain(token);

  // Mesmo link de novo: já utilizado.
  const again = await (await browser.newContext()).newPage();
  await again.goto(link);
  await expect(again.getByText("Este convite já foi utilizado.")).toBeVisible();
  // Convite revogado.
  const revokedLink = await newInviteLink(ana.page);
  await ana.page.getByRole("button", { name: "Revogar" }).first().click();
  await ana.page.getByRole("button", { name: "Revogar", exact: true }).last().click();
  await again.goto("about:blank");
  await again.goto(revokedLink);
  await expect(again.getByText("Este convite foi revogado.")).toBeVisible();
  await ana.context.close();
  await ctx.close();
});

test("link antigo (/convite/<token>) não encaminha o token à API", async ({ page }) => {
  const urls = recordUrls(page);
  const fake = "A".repeat(43);
  await page.goto(`/convite/${fake}`);
  await expect(page.getByRole("heading", { name: "Link de convite em formato antigo" })).toBeVisible();
  expect(urls.filter((u) => u.includes("/bff/")).some((u) => u.includes(fake))).toBe(false);
  expect(urls.some((u) => u.includes("/bff/public/invitations/lookup"))).toBe(false);
});

test("equipe: projeções, delegação refletida na UI e falha de rede sem repetir a mutação", async ({ browser }) => {
  const ana = await person(browser, "Ana Gestora");
  await createOffice(ana.page, "Equipe Integrada");
  const link = await newInviteLink(ana.page);
  const bia = await person(browser, "Bia Membro");
  await bia.page.goto(link);
  await bia.page.getByRole("button", { name: "Aceitar convite" }).click();
  await bia.page.getByRole("button", { name: "Aceitar e entrar" }).click();
  await expect(bia.page).toHaveURL(/\/app\/escritorio$/);

  await bia.page.goto("/app/escritorio/equipe");                // projeção pública: sem e-mails/permissões
  await expect(bia.page.getByText("Ana Gestora")).toBeVisible();
  await expect(bia.page.getByText(ana.email)).toHaveCount(0);
  await expect(bia.page.getByText("Gerir equipe")).toHaveCount(0);
  await expect(bia.page.getByText("Código de ingresso")).toHaveCount(0);

  await ana.page.goto("/app/escritorio/equipe");                // projeção administrativa
  await expect(ana.page.getByText(bia.email)).toBeVisible();
  // Falha de rede numa mutação: erro exibido, formulário preservado, UM único envio.
  let patches = 0;
  await ana.page.route("**/bff/api/offices/*/members/*", async (route) => {
    if (route.request().method() === "PATCH") { patches++; await route.abort("connectionreset"); } else await route.continue();
  });
  const row = ana.page.locator('li[data-testid^="member-"]', { hasText: "Bia Membro" });
  await row.getByRole("button", { name: "Editar" }).click();
  await ana.page.getByLabel("Cargo (rótulo visual)").fill("Coordenadora");
  await ana.page.getByRole("checkbox", { name: "Gerir equipe" }).check();
  await ana.page.getByRole("button", { name: "Salvar" }).click();
  // 6.3: erro de rede numa MUTAÇÃO = resultado desconhecido (pode ter ocorrido), não "sem conexão".
  await expect(ana.page.getByText("ela pode ter ocorrido")).toBeVisible();
  await expect(ana.page.getByLabel("Cargo (rótulo visual)")).toHaveValue("Coordenadora");
  expect(patches).toBe(1);
  await ana.page.unroute("**/bff/api/offices/*/members/*");
  await ana.page.getByRole("button", { name: "Salvar" }).click();   // novo envio só por ação explícita
  await expect(ana.page.getByText("Membro atualizado.")).toBeVisible();

  await bia.page.goto("/app/escritorio");                        // permissão nova vale no servidor
  await expect(bia.page.getByText("Código de ingresso")).toBeVisible();
  await bia.page.goto("/app/escritorio/equipe");
  const anaRow = bia.page.locator('li[data-testid^="member-"]', { hasText: "Ana Gestora" });
  await expect(anaRow.getByRole("button", { name: "Editar" })).toHaveCount(0);   // gestor não edita admin
  await ana.context.close();
  await bia.context.close();
});

test("solicitação por código: pedir, aprovar e entrar; cancelar (rejeição coberta na integração real)", async ({ browser }) => {
  const ana = await person(browser, "Ana Aprova");
  await createOffice(ana.page, "Código & Ingresso");
  const code = (await ana.page.getByTestId("join-code").textContent())!.trim();
  const caio = await person(browser, "Caio Pede");
  await caio.page.goto("/solicitar-ingresso");
  await caio.page.getByLabel("Código de ingresso").fill(code);
  await caio.page.getByRole("button", { name: "Solicitar ingresso" }).click();
  await expect(caio.page.getByText("Solicitação enviada para “Código & Ingresso”")).toBeVisible();
  await expect(caio.page.getByText("Pendente")).toBeVisible();

  await ana.page.reload();
  await ana.page.getByRole("button", { name: "Aprovar" }).click();
  await ana.page.getByRole("button", { name: "Aprovar", exact: true }).last().click();
  await expect(ana.page.getByText("Solicitação aprovada.")).toBeVisible();
  await caio.page.goto("/app/escritorio");
  await expect(caio.page.getByRole("heading", { name: "Código & Ingresso" })).toBeVisible();

  const dani = await person(browser, "Dani Desiste");
  await dani.page.goto("/solicitar-ingresso");
  await dani.page.getByLabel("Código de ingresso").fill(code);
  await dani.page.getByRole("button", { name: "Solicitar ingresso" }).click();
  await dani.page.getByRole("button", { name: "Cancelar" }).first().click();
  await dani.page.getByRole("button", { name: "Cancelar solicitação" }).click();
  await expect(dani.page.getByText("Cancelada")).toBeVisible();
  for (const c of [ana, caio, dani]) await c.context.close();
});

test("remoção com reatribuição e perda imediata de acesso na sessão do removido", async ({ browser }) => {
  const ana = await person(browser, "Ana Remove");
  await createOffice(ana.page, "Remoções Ltda");
  const link = await newInviteLink(ana.page);
  const bia = await person(browser, "Bia Sai");
  await bia.page.goto(link);
  await bia.page.getByRole("button", { name: "Aceitar convite" }).click();
  await bia.page.getByRole("button", { name: "Aceitar e entrar" }).click();
  await expect(bia.page).toHaveURL(/\/app\/escritorio$/);
  await createDeadlineFor(ana.email, await userIdOf(bia.page));   // Bia tem responsabilidade em aberto

  await ana.page.goto("/app/escritorio/equipe");
  const row = ana.page.locator('li[data-testid^="member-"]', { hasText: "Bia Sai" });
  await row.getByRole("button", { name: "Remover" }).click();
  await ana.page.getByRole("button", { name: "Remover", exact: true }).last().click();
  await expect(ana.page.getByText("responsabilidades em aberto").first()).toBeVisible();   // sem contagem inventada
  await ana.page.getByLabel("Reatribuir para").selectOption({ label: "Ana Remove" });
  await ana.page.getByRole("button", { name: "Remover", exact: true }).last().click();
  await expect(ana.page.getByText("Membro removido.")).toBeVisible();
  await expect(ana.page.getByText("Bia Sai")).toHaveCount(0);

  await bia.page.goto("/app/escritorio");                        // mesma sessão: sem acesso, volta ao pessoal
  await expect(bia.page.getByText("Você não pertence a um escritório no momento.")).toBeVisible();
  await expect(bia.page.getByText("Remoções Ltda")).toHaveCount(0);
  await expect(bia.page.getByLabel("Ambiente")).toHaveValue("personal");
  await ana.context.close();
  await bia.context.close();
});

test("saída do último administrador exige sucessor", async ({ browser }) => {
  const ana = await person(browser, "Ana Única");
  await createOffice(ana.page, "Sucessão SA");
  const link = await newInviteLink(ana.page);
  const bia = await person(browser, "Bia Sucede");
  await bia.page.goto(link);
  await bia.page.getByRole("button", { name: "Aceitar convite" }).click();
  await bia.page.getByRole("button", { name: "Aceitar e entrar" }).click();
  await ana.page.goto("/app/escritorio/equipe");
  await ana.page.getByRole("button", { name: "Sair do escritório" }).click();
  await ana.page.getByRole("button", { name: "Sair", exact: true }).last().click();
  await expect(ana.page.getByText("último administrador")).toBeVisible();
  await ana.page.getByLabel("Novo administrador").selectOption({ label: "Bia Sucede" });
  await ana.page.getByRole("button", { name: "Sair", exact: true }).last().click();
  await expect(ana.page).toHaveURL(/\/app$/);
  await expect(ana.page.getByLabel("Ambiente")).toHaveValue("personal");
  await bia.page.goto("/app/escritorio");
  await expect(bia.page.getByText("Código de ingresso")).toBeVisible();   // agora administra
  await logout(ana.page);
  await ana.context.close();
  await bia.context.close();
});

test("troca de usuário no mesmo navegador não mostra dados do escritório anterior", async ({ browser }) => {
  const ana = await person(browser, "Ana Troca");
  await createOffice(ana.page, "Escritório Secreto");
  await logout(ana.page);
  await signupToOnboarding(ana.page, "Outro Usuário", newEmail());
  await ana.page.getByRole("button", { name: "Usar ambiente pessoal" }).click();
  await expect(ana.page.getByText("Escritório Secreto")).toHaveCount(0);
  await expect(ana.page.getByLabel("Ambiente")).toHaveValue("personal");
  await ana.page.goto("/app/escritorio");
  await expect(ana.page.getByText("Escritório Secreto")).toHaveCount(0);
  await ana.context.close();
});

test("duas abas: saída do escritório numa aba ressincroniza a outra (aviso não concede acesso)", async ({ browser }) => {
  const ana = await person(browser, "Ana Abas");
  await createOffice(ana.page, "Abas Unidas");
  const link = await newInviteLink(ana.page);
  const bia = await person(browser, "Bia Duas Abas");
  await bia.page.goto(link);
  await bia.page.getByRole("button", { name: "Aceitar convite" }).click();
  await bia.page.getByRole("button", { name: "Aceitar e entrar" }).click();
  await expect(bia.page).toHaveURL(/\/app\/escritorio$/);
  const tabB = await bia.context.newPage();                        // mesma sessão (mesmo contexto)
  await tabB.goto("/app/escritorio");
  await expect(tabB.getByRole("heading", { name: "Abas Unidas" })).toBeVisible();
  await bia.page.goto("/app/escritorio/equipe");
  await bia.page.getByRole("button", { name: "Sair do escritório" }).click();
  await bia.page.getByRole("button", { name: "Sair", exact: true }).last().click();
  await expect(bia.page).toHaveURL(/\/app$/);
  await expect(tabB.getByText("Você não pertence a um escritório no momento.")).toBeVisible();
  await expect(tabB.getByText("Abas Unidas")).toHaveCount(0);
  await ana.context.close();
  await bia.context.close();
});

// ---------------------------------------------------------------- auditoria da 6.2
async function idsOf(page: Page) {
  return page.evaluate(async () => {
    const h = { headers: { "x-prazoai-csrf": "1" } };
    const s = await (await fetch("/bff/session", h)).json();
    const m = await (await fetch("/bff/api/memberships/me", h)).json();
    return { uid: s.user.id as string, oid: (m.office?.id ?? null) as string | null };
  });
}
/** Alteração de permissões feita PELO administrador na própria sessão (mesmo contrato da tela). */
async function setPerms(adminPage: Page, oid: string, uid: string, permissions: string[]) {
  const status = await adminPage.evaluate(async ({ oid, uid, permissions }) => (await fetch(`/bff/api/offices/${oid}/members/${uid}`, {
    method: "PATCH", headers: { "x-prazoai-csrf": "1", "content-type": "application/json" }, body: JSON.stringify({ permissions }),
  })).status, { oid, uid, permissions });
  expect(status).toBe(200);
}
const FULL_MANAGER = ["deadline.read", "deadline.create", "deadline.edit", "deadline.complete", "team.manage"];

async function officeWithMember(browser: Browser, adminName: string, office: string, memberName: string) {
  const ana = await person(browser, adminName);
  await createOffice(ana.page, office);
  const link = await newInviteLink(ana.page);
  const bia = await person(browser, memberName);
  await bia.page.goto(link);
  await bia.page.getByRole("button", { name: "Aceitar convite" }).click();
  await bia.page.getByRole("button", { name: "Aceitar e entrar" }).click();
  await expect(bia.page).toHaveURL(/\/app\/escritorio$/);
  const { oid } = await idsOf(ana.page);
  const { uid } = await idsOf(bia.page);
  return { ana, bia, oid: oid!, uid };
}

test("auditoria 6.2: perda de team.manage descarta dados administrativos na mesma aba; resposta antiga não volta", async ({ browser }) => {
  const { ana, bia, oid, uid } = await officeWithMember(browser, "Ana Revoga", "Revisões SA", "Bia Gestora");
  await setPerms(ana.page, oid, uid, FULL_MANAGER);
  const projections: string[] = [];
  bia.page.on("response", async (r) => {
    if (/\/bff\/api\/offices\/[^/]+\/members$/.test(new URL(r.url()).pathname) && r.request().method() === "GET") {
      try { projections.push((await r.json()).projection); } catch { /* resposta abortada */ }
    }
  });
  await bia.page.goto("/app/escritorio/equipe");
  await expect(bia.page.getByText(ana.email)).toBeVisible();              // projeção administrativa
  await expect(bia.page.getByText("Membros (visão de gestão)")).toBeVisible();

  // Pausa a PRÓXIMA consulta de membros (feita enquanto Bia ainda é gestora → resposta administrativa).
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  let held = 0;
  await bia.page.route(/\/bff\/api\/offices\/[^/]+\/members$/, async (route) => {
    if (held === 0 && route.request().method() === "GET") {
      held += 1;
      const resp = await route.fetch();
      await gate;
      await route.fulfill({ response: resp }).catch(() => {});             // a requisição já foi abortada
    } else await route.continue();
  });
  await bia.page.getByRole("link", { name: "Equipe" }).click();          // nova consulta (fica pausada)
  await expect.poll(() => held).toBe(1);

  await setPerms(ana.page, oid, uid, ["deadline.read"]);                  // administrador retira team.manage
  await bia.page.evaluate(() => window.dispatchEvent(new Event("focus"))); // a mesma aba revalida (sem recarregar)
  await expect(bia.page.getByText(ana.email)).toHaveCount(0);             // dados, não só botões
  await expect(bia.page.getByText("Gerir equipe")).toHaveCount(0);
  await expect(bia.page.getByText("Membros (visão de gestão)")).toHaveCount(0);
  await expect(bia.page.getByText("Ana Revoga")).toBeVisible();
  await expect.poll(() => projections.at(-1)).toBe("public");             // nova consulta pública
  release();                                                              // resposta antiga (administrativa) chega
  await bia.page.waitForLoadState("networkidle");
  await expect(bia.page.getByText(ana.email)).toHaveCount(0);
  await expect(bia.page.getByText("Gerir equipe")).toHaveCount(0);
  await bia.page.unroute(/\/bff\/api\/offices\/[^/]+\/members$/);

  await setPerms(ana.page, oid, uid, FULL_MANAGER);                       // recupera a permissão
  await bia.page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(bia.page.getByText(ana.email)).toBeVisible();
  await expect(bia.page.getByText("Membros (visão de gestão)")).toBeVisible();
  await ana.context.close();
  await bia.context.close();
});

test("auditoria 6.2: gestor com deadline.read + team.manage rejeita pela interface, mas não vê Aprovar", async ({ browser }) => {
  const { ana, bia, oid, uid } = await officeWithMember(browser, "Ana Delega", "Rejeições Ltda", "Bia Rejeita");
  await setPerms(ana.page, oid, uid, ["deadline.read", "team.manage"]);
  await ana.page.goto("/app/escritorio");
  const code = (await ana.page.getByTestId("join-code").textContent())!.trim();
  const caio = await person(browser, "Caio Recusado");
  await caio.page.goto("/solicitar-ingresso");
  await caio.page.getByLabel("Código de ingresso").fill(code);
  await caio.page.getByRole("button", { name: "Solicitar ingresso" }).click();
  await expect(caio.page.getByText("Pendente")).toBeVisible();

  await bia.page.goto("/app/escritorio");
  const row = bia.page.locator("li", { hasText: "Caio Recusado" });
  await expect(row).toBeVisible();                                        // lista
  await expect(row.getByRole("button", { name: "Aprovar" })).toHaveCount(0);
  await row.getByRole("button", { name: "Rejeitar" }).click();
  await bia.page.getByRole("button", { name: "Rejeitar", exact: true }).last().click();
  await expect(bia.page.getByText("Solicitação rejeitada.")).toBeVisible();
  await caio.page.reload();
  await expect(caio.page.getByText("Rejeitada")).toBeVisible();
  for (const c of [ana, bia, caio]) await c.context.close();
});
