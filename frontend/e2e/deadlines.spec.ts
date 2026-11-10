// E2E 6.3 — prazos e calendário: navegador real + Next (build integrado) + FastAPI real.
// Usuários diferentes = contextos diferentes; abas do mesmo contexto compartilham a sessão.
import { expect, test, type Page } from "@playwright/test";
import {
  BACKEND, backendToken, createOfficeVia, idsOf, joinByInvite, patchMember, personIn, seedDeadlines,
} from "./helpers";

test.describe.configure({ mode: "serial" });
const DEMO_TEXTS = ["Contestação — locação residencial", "Paula Andrade", "Rafael Neves"];
const MEMBER = ["deadline.read", "deadline.create", "deadline.edit", "deadline.complete"];

async function fillDeadline(page: Page, f: { title: string; due: string; start?: string; responsible?: string }) {
  await page.getByLabel("Título").fill(f.title);
  await page.getByLabel("Número do processo").fill("0001234-56.2026");
  await page.getByLabel("Tribunal / vara").fill("TJSC 2ª Vara");
  await page.getByLabel("Área de atuação").fill("Cível");
  if (f.responsible) await page.getByLabel("Responsável").selectOption({ label: f.responsible });
  await page.getByLabel("Início").fill(f.start ?? "2026-11-01");
  await page.getByLabel("Vencimento").fill(f.due);
  await page.getByLabel("Duração em dias (referência)").fill("10");
}

async function newDeadline(page: Page, f: Parameters<typeof fillDeadline>[1]) {
  await page.goto("/app/prazos/novo");
  await fillDeadline(page, f);
  await page.getByRole("button", { name: "Salvar prazo" }).click();
  await expect(page).toHaveURL(/\/app\/prazos\/[A-Za-z0-9_-]+$/);
  await expect(page.getByRole("heading", { name: f.title })).toBeVisible();
  return page.url().split("/").pop()!;
}

function urls(page: Page) {
  const list: string[] = [];
  page.on("request", (r) => list.push(r.url()));
  return list;
}

test("pessoal: cadastro, edição, status, comentário e datas iguais em fusos distintos", async ({ browser }) => {
  const ana = await personIn(browser, "Ana Fusos", { timezoneId: "Pacific/Kiritimati" });   // UTC+14
  await ana.page.getByRole("button", { name: "Usar ambiente pessoal" }).click();
  const seen = urls(ana.page);
  const id = await newDeadline(ana.page, { title: "Contestação civil", due: "2026-11-20" });
  await expect(ana.page.getByTestId("due-date")).toHaveText("20/11/2026");
  await expect(ana.page.getByText("não é cálculo processual oficial")).toBeVisible();
  const la = await browser.newContext({ timezoneId: "America/Los_Angeles" });           // UTC-8: mesma conta, outro fuso
  const laPage = await la.newPage();
  await laPage.goto("/login");
  await laPage.getByLabel("E-mail").fill(ana.email);
  await laPage.locator('input[autocomplete="current-password"]').fill("Senha-de-teste-123");
  await laPage.getByRole("button", { name: "Entrar", exact: true }).click();
  await expect(laPage).toHaveURL(/\/app$/);
  await laPage.goto(`/app/prazos/${id}`);
  await expect(laPage.getByTestId("due-date")).toHaveText("20/11/2026");                 // sem mudança de dia
  await la.close();

  await ana.page.getByRole("button", { name: "Editar prazo" }).click();
  await ana.page.getByLabel("Título").fill("Contestação civil revisada");
  await ana.page.getByRole("button", { name: "Salvar alterações" }).click();
  await expect(ana.page.getByRole("heading", { name: "Contestação civil revisada" })).toBeVisible();
  await ana.page.getByRole("button", { name: "Concluir" }).click();
  await ana.page.getByRole("button", { name: "Concluir", exact: true }).last().click();
  await expect(ana.page.getByText("Status: Concluído.")).toBeVisible();
  await ana.page.getByRole("button", { name: "Reabrir" }).click();
  await ana.page.getByRole("button", { name: "Reabrir", exact: true }).last().click();
  await expect(ana.page.getByText("Status: Em aberto.")).toBeVisible();
  await ana.page.getByLabel("Novo comentário").fill("Protocolado hoje.");
  await ana.page.getByRole("button", { name: "Comentar" }).click();
  await expect(ana.page.getByText("Protocolado hoje.")).toBeVisible();
  await expect(ana.page.getByText("Status: concluído → em aberto.")).toBeVisible();     // histórico
  const storage = await ana.page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }));
  expect(storage).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}/);
  expect(storage).not.toContain("prazoai:demo");
  expect(seen.some((u) => /eyJ[A-Za-z0-9_-]{10,}/.test(u))).toBe(false);
  for (const t of DEMO_TEXTS) await expect(ana.page.getByText(t)).toHaveCount(0);
  await ana.context.close();
});

test("lista: filtros, ordenação e paginação são do servidor", async ({ browser }) => {
  const ana = await personIn(browser, "Ana Lista");
  await ana.page.getByRole("button", { name: "Usar ambiente pessoal" }).click();
  await seedDeadlines(ana.email, 23);
  await seedDeadlines(ana.email, 1, { title: "Réplica de dezembro", dueDate: "2026-12-05" });
  const listReqs: string[] = [];
  ana.page.on("request", (r) => { if (r.url().includes("/bff/api/deadlines?")) listReqs.push(r.url()); });
  await ana.page.goto("/app/prazos");
  await expect(ana.page.getByTestId("result-count")).toContainText("24 resultado(s)");
  await expect(ana.page.getByText("Página 1 de 2")).toBeVisible();
  await ana.page.getByRole("button", { name: "Página 2" }).click();
  await expect(ana.page.getByText("Página 2 de 2")).toBeVisible();
  await ana.page.getByLabel("Buscar").fill("réplica");
  await expect(ana.page.getByTestId("result-count")).toContainText("1 resultado(s)");
  await expect(ana.page.getByRole("link", { name: "Réplica de dezembro" })).toBeVisible();
  await ana.page.getByLabel("Buscar").fill("");
  await ana.page.getByLabel("Ordenar por").selectOption("title");
  await ana.page.getByLabel("Ordem").selectOption("desc");
  await expect(ana.page.locator("table tbody tr").first()).toContainText("Réplica de dezembro");
  expect(listReqs.some((u) => u.includes("sort=title") && u.includes("dir=desc"))).toBe(true);
  expect(listReqs.some((u) => u.includes("page=2"))).toBe(true);
  await ana.context.close();
});

test("escritório: assigned × all, responsáveis por nome e isolamento do pessoal", async ({ browser }) => {
  const ana = await personIn(browser, "Ana Sócia");
  await createOfficeVia(ana.page, "Prazos & Cia");
  const bia = await personIn(browser, "Bia Associada");
  await joinByInvite(ana.page, bia.page);
  await newDeadline(ana.page, { title: "Prazo da Bia", due: "2026-11-25", responsible: "Bia Associada" });
  await newDeadline(ana.page, { title: "Prazo da Ana", due: "2026-11-26" });
  await bia.page.goto("/app/prazos");
  await expect(bia.page.getByRole("link", { name: "Prazo da Bia" })).toBeVisible();
  await expect(bia.page.getByRole("link", { name: "Prazo da Ana" })).toHaveCount(0);     // assigned
  await expect(bia.page.getByTestId("result-count")).toContainText("1 resultado(s)");
  await bia.page.goto("/app/prazos/novo");
  await expect(bia.page.getByLabel("Responsável")).toBeDisabled();                        // assigned: só a si
  await ana.page.goto("/app/prazos");
  await expect(ana.page.getByText("Bia Associada")).toBeVisible();                        // nome, não id
  const { uid } = await idsOf(bia.page);
  await expect(ana.page.getByText(uid)).toHaveCount(0);
  // Pessoal da Bia é invisível para a administradora.
  await bia.page.getByLabel("Ambiente").selectOption("personal");
  const personalId = await newDeadline(bia.page, { title: "Particular da Bia", due: "2026-11-27" });
  await ana.page.goto(`/app/prazos/${personalId}`);
  await expect(ana.page.getByText("Você não tem acesso a esta área ou ela não existe mais.")).toBeVisible();
  await expect(ana.page.getByText("Particular da Bia")).toHaveCount(0);
  await ana.context.close();
  await bia.context.close();
});

test("conflito de edição em duas abas: nada é sobrescrito; reaplicação exige nova confirmação", async ({ browser }) => {
  const ana = await personIn(browser, "Ana Abas");
  await ana.page.getByRole("button", { name: "Usar ambiente pessoal" }).click();
  const id = await newDeadline(ana.page, { title: "Prazo disputado", due: "2026-11-20" });
  const tabB = await ana.context.newPage();
  await tabB.goto(`/app/prazos/${id}`);
  await tabB.getByRole("button", { name: "Editar prazo" }).click();
  await ana.page.getByRole("button", { name: "Editar prazo" }).click();
  await ana.page.getByLabel("Título").fill("Versão da aba A");
  await ana.page.getByRole("button", { name: "Salvar alterações" }).click();
  await expect(ana.page.getByRole("heading", { name: "Versão da aba A" })).toBeVisible();
  let patches = 0;
  tabB.on("request", (r) => { if (r.method() === "PATCH") patches++; });
  await tabB.getByLabel("Título").fill("Versão da aba B");
  await tabB.getByRole("button", { name: "Salvar alterações" }).click();
  await expect(tabB.getByText("foi alterado por outra pessoa ou aba")).toBeVisible();
  await expect(tabB.getByLabel("Título")).toHaveValue("Versão da aba B");               // rascunho preservado
  expect(patches).toBe(1);                                                              // sem reenvio automático
  await tabB.getByRole("button", { name: /Carregar versão atual/ }).click();
  await expect(tabB.getByRole("heading", { name: "Versão da aba A" })).toBeVisible();
  await expect(tabB.getByLabel("Título")).toHaveValue("Versão da aba B");
  await tabB.getByRole("button", { name: "Salvar alterações" }).click();               // nova confirmação explícita
  await expect(tabB.getByRole("heading", { name: "Versão da aba B" })).toBeVisible();
  expect(patches).toBe(2);
  await ana.context.close();
});

test("comentário com resultado desconhecido: não repete; conferência mostra um único comentário", async ({ browser }) => {
  const ana = await personIn(browser, "Ana Rede");
  await ana.page.getByRole("button", { name: "Usar ambiente pessoal" }).click();
  const id = await newDeadline(ana.page, { title: "Prazo instável", due: "2026-11-20" });
  let posts = 0;
  await ana.page.route(`**/bff/api/deadlines/${id}/comments`, async (route) => {
    if (route.request().method() === "POST") {
      posts++;
      await route.fetch();                                   // o servidor GRAVA o comentário…
      await route.abort("connectionreset");                  // …mas a resposta se perde
    } else await route.continue();
  });
  await ana.page.getByLabel("Novo comentário").fill("Comentário único");
  await ana.page.getByRole("button", { name: "Comentar" }).click();
  await expect(ana.page.getByText("ela pode ter ocorrido")).toBeVisible();
  await expect(ana.page.getByLabel("Novo comentário")).toHaveValue("Comentário único");
  expect(posts).toBe(1);
  await ana.page.getByRole("button", { name: "Conferir comentários" }).click();
  await expect(ana.page.locator('ul[aria-label="Comentários"] li')).toHaveCount(1);
  expect(posts).toBe(1);
  await ana.context.close();
});

test("calendário: mês do servidor com mais resultados que uma página (todas as páginas)", async ({ browser }) => {
  const ana = await personIn(browser, "Ana Calendário");
  await ana.page.getByRole("button", { name: "Usar ambiente pessoal" }).click();
  const ref: string = await ana.page.evaluate(async () =>
    (await (await fetch("/bff/api/deadlines?scope=personal&perPage=1", { headers: { "x-prazoai-csrf": "1" } })).json()).referenceDate);
  const day = `${ref.slice(0, 8)}15`;
  await seedDeadlines(ana.email, 505, { dueDate: day, startDate: `${ref.slice(0, 8)}01` });   // > 500 por página
  const pages: string[] = [];
  ana.page.on("request", (r) => { if (r.url().includes("/bff/api/calendar?")) pages.push(new URL(r.url()).searchParams.get("page") ?? ""); });
  const secondPage: Array<{ id: string; title: string }> = [];
  ana.page.on("response", async (r) => {
    if (r.url().includes("/bff/api/calendar?") && new URL(r.url()).searchParams.get("page") === "2") secondPage.push(...(await r.json()).items);
  });
  await ana.page.goto("/app/calendario");
  await expect(ana.page.getByTestId("calendar-total")).toContainText("505 prazo(s) no mês · 2 páginas carregadas");
  await expect(ana.page.getByTestId(`count-${day}`)).toHaveText("505");
  expect(pages).toEqual(["1", "2"]);
  // Auditoria 6.3: um item que veio da SEGUNDA página é acessível pela interface.
  expect(secondPage.length).toBe(5);
  const fromPage2 = secondPage[0];
  await ana.page.getByTestId(`day-${day}`).getByRole("button", { name: /Ver todos os 505 prazos/ }).click();
  const dialog = ana.page.getByRole("dialog");
  await expect(dialog.getByText("505 de 505 prazo(s) deste dia")).toBeVisible();
  await dialog.getByRole("link", { name: fromPage2.title, exact: true }).click();
  await expect(ana.page).toHaveURL(new RegExp(`/app/prazos/${fromPage2.id}$`));
  await expect(ana.page.getByRole("heading", { name: fromPage2.title })).toBeVisible();
  await ana.page.goto("/app/calendario");
  await ana.page.getByRole("button", { name: "Próximo mês" }).click();
  await expect(ana.page.getByTestId("calendar-total")).toContainText("0 prazo(s) no mês");
  await ana.context.close();
});

test("perda de deadline.read com a tela aberta: resposta antiga pausada não restaura dados", async ({ browser }) => {
  const ana = await personIn(browser, "Ana Revoga");
  await createOfficeVia(ana.page, "Revogações SA");
  const bia = await personIn(browser, "Bia Perde");
  await joinByInvite(ana.page, bia.page);
  const { oid } = await idsOf(ana.page);
  const { uid } = await idsOf(bia.page);
  await patchMember(ana.page, oid!, uid, { visibility: "all" });
  await newDeadline(ana.page, { title: "Segredo do escritório", due: "2026-11-21" });
  await bia.page.goto("/app/prazos");
  await expect(bia.page.getByRole("link", { name: "Segredo do escritório" })).toBeVisible();

  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  let held = 0;
  await bia.page.route("**/bff/api/deadlines?*", async (route) => {
    if (held === 0) { held++; const resp = await route.fetch(); await gate; await route.fulfill({ response: resp }).catch(() => {}); }
    else await route.continue();
  });
  await bia.page.getByLabel("Ordenar por").selectOption("title");          // nova consulta (fica pausada)
  await expect.poll(() => held).toBe(1);
  await patchMember(ana.page, oid!, uid, { permissions: ["deadline.create"] });           // perde deadline.read
  await bia.page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(bia.page.getByText("Você não tem a permissão “Ver prazos”")).toBeVisible();
  release();
  await bia.page.waitForLoadState("networkidle");
  await expect(bia.page.getByText("Segredo do escritório")).toHaveCount(0);
  await expect(bia.page).not.toHaveURL(/\/login$/);                                         // sem logout
  await bia.page.unroute("**/bff/api/deadlines?*");
  await patchMember(ana.page, oid!, uid, { permissions: MEMBER });                         // recupera
  await bia.page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(bia.page.getByRole("link", { name: "Segredo do escritório" })).toBeVisible();
  await ana.context.close();
  await bia.context.close();
});

test("responsável inativo: reabrir exige escolher novo responsável", async ({ browser }) => {
  const ana = await personIn(browser, "Ana Reabre");
  await createOfficeVia(ana.page, "Reaberturas");
  const bia = await personIn(browser, "Bia Saiu");
  await joinByInvite(ana.page, bia.page);
  const id = await newDeadline(ana.page, { title: "Concluído da Bia", due: "2026-11-22", responsible: "Bia Saiu" });
  await ana.page.getByRole("button", { name: "Concluir" }).click();
  await ana.page.getByRole("button", { name: "Concluir", exact: true }).last().click();
  await expect(ana.page.getByText("Status: Concluído.")).toBeVisible();
  const { oid } = await idsOf(ana.page);
  const { uid } = await idsOf(bia.page);
  const status = await ana.page.evaluate(async ({ oid, uid }) => (await fetch(`/bff/api/offices/${oid}/members/${uid}/remove`, {
    method: "POST", headers: { "x-prazoai-csrf": "1", "content-type": "application/json" }, body: "{}" })).status, { oid: oid!, uid });
  expect(status).toBe(204);
  await ana.page.goto(`/app/prazos/${id}`);
  await expect(ana.page.getByTestId("responsible")).toHaveText("Pessoa fora do escritório");
  await ana.page.getByRole("button", { name: "Reabrir" }).click();
  await ana.page.getByRole("button", { name: "Reabrir", exact: true }).last().click();
  await expect(ana.page.getByText("O responsável não pertence mais ao escritório")).toBeVisible();
  await ana.page.getByLabel("Novo responsável").selectOption({ label: "Ana Reabre" });
  await ana.page.getByRole("button", { name: "Reabrir com novo responsável" }).click();
  await expect(ana.page.getByText("Status: Em aberto.")).toBeVisible();
  await expect(ana.page.getByTestId("responsible")).toHaveText("Ana Reabre (você)");
  await ana.context.close();
  await bia.context.close();
});

test("transferência: consentimento de compartilhamento e confirmação específica da intimação vinculada", async ({ browser }) => {
  const ana = await personIn(browser, "Ana Transfere");
  await createOfficeVia(ana.page, "Transferências");
  await ana.page.getByLabel("Ambiente").selectOption("personal");
  const id = await newDeadline(ana.page, { title: "Pessoal para o escritório", due: "2026-11-23" });
  await ana.page.getByRole("button", { name: "Transferir…" }).click();
  await expect(ana.page.getByText("comentários e histórico deste prazo passam a ser visíveis")).toBeVisible();
  await ana.page.getByRole("button", { name: "Transferir", exact: true }).click();
  await expect(ana.page.getByText("Confirme o compartilhamento para transferir.")).toBeVisible();
  await ana.page.getByLabel(/Entendo e quero compartilhar/).check();
  await ana.page.getByRole("button", { name: "Transferir", exact: true }).click();
  await expect(ana.page.getByText(/Prazo transferido ao escritório/)).toBeVisible();
  // Auditoria 6.3: agora o prazo é do escritório; no ambiente pessoal, pede troca explícita.
  await expect(ana.page.getByRole("heading", { name: "Prazo de outro ambiente" })).toBeVisible();
  expect(id).toBeTruthy();

  // Fixture: prazo pessoal criado a partir de intimação, pela API EXISTENTE do backend.
  const token = await backendToken(ana.email);
  const H = { "content-type": "application/json", authorization: `Bearer ${token}` };
  const intim = await (await fetch(`${BACKEND}/api/v1/intimations`, { method: "POST", headers: H,
    body: JSON.stringify({ scope: "personal", fileName: "intimacao.pdf", sizeBytes: 100, contentType: "application/pdf", receivedAt: "2026-11-01" }) })).json();
  const conf = await (await fetch(`${BACKEND}/api/v1/intimations/${intim.id}/confirm`, { method: "POST", headers: H,
    body: JSON.stringify({ version: 1, title: "Prazo com intimação", caseNumber: "0001234-56.2026", court: "TJSC", practiceArea: "Cível",
      startDate: "2026-11-01", dueDate: "2026-11-24", countingMode: "business", duration: 10 }) })).json();
  const bodies: string[] = [];
  ana.page.on("request", (r) => { if (r.url().endsWith("/transfer")) bodies.push(r.postData() ?? ""); });
  await ana.page.getByLabel("Ambiente").selectOption("personal");
  await ana.page.goto(`/app/prazos/${conf.deadline.id}`);
  await ana.page.getByRole("button", { name: "Transferir…" }).click();
  await ana.page.getByLabel(/Entendo e quero compartilhar/).check();
  await ana.page.getByRole("button", { name: "Transferir", exact: true }).click();
  await expect(ana.page.getByText("intimação vinculada").first()).toBeVisible();
  expect(bodies[0]).not.toContain("shareLinkedIntimation");                                 // nunca silencioso
  await ana.page.getByLabel(/intimação vinculada/).check();
  await ana.page.getByRole("button", { name: "Transferir", exact: true }).click();
  await expect(ana.page.getByText(/Prazo transferido ao escritório/)).toBeVisible();
  expect(bodies[1]).toContain('"shareLinkedIntimation":true');
  await ana.page.getByRole("button", { name: "Abrir no ambiente do escritório" }).click();
  await expect(ana.page.getByText("com a intimação vinculada")).toBeVisible();              // histórico sem ids
  await ana.context.close();
});

// ---------------------------------------------------------------- auditoria da 6.3
test("auditoria 6.3: cinco prazos no mesmo dia — um além dos três primeiros é aberto pela interface", async ({ browser }) => {
  const ana = await personIn(browser, "Ana Dia Cheio");
  await ana.page.getByRole("button", { name: "Usar ambiente pessoal" }).click();
  const ref: string = await ana.page.evaluate(async () =>
    (await (await fetch("/bff/api/deadlines?scope=personal&perPage=1", { headers: { "x-prazoai-csrf": "1" } })).json()).referenceDate);
  const day = `${ref.slice(0, 8)}10`;
  await seedDeadlines(ana.email, 5, { dueDate: day, startDate: `${ref.slice(0, 8)}01` });
  await ana.page.goto("/app/calendario");
  const cell = ana.page.getByTestId(`day-${day}`);
  await expect(cell.getByRole("link")).toHaveCount(3);
  const shown = await cell.getByRole("link").allInnerTexts();
  await cell.getByRole("button", { name: /Ver todos os 5 prazos/ }).click();
  const dialog = ana.page.getByRole("dialog");
  await expect(dialog.getByRole("link")).toHaveCount(5);
  const hiddenTitle = (await dialog.getByRole("link").allInnerTexts()).find((t) => !shown.includes(t))!;
  expect(hiddenTitle).toBeTruthy();
  await dialog.getByRole("link", { name: hiddenTitle, exact: true }).click();
  await expect(ana.page.getByRole("heading", { name: hiddenTitle })).toBeVisible();
  await ana.context.close();
});

async function officeDeadline(page: Page, title: string) {
  return page.evaluate(async (title) => (await (await fetch("/bff/api/deadlines", { method: "POST",
    headers: { "x-prazoai-csrf": "1", "content-type": "application/json" },
    body: JSON.stringify({ scope: "office", title, caseNumber: "0001234-56.2026", court: "TJSC", practiceArea: "Cível",
      startDate: "2026-11-01", dueDate: "2026-11-20", countingMode: "business", duration: 10 }) })).json()).id as string, title);
}

test("auditoria 6.3: membro só leitura no ambiente pessoal abrindo prazo do escritório por URL", async ({ browser }) => {
  const ana = await personIn(browser, "Ana Admin Leitura");
  await createOfficeVia(ana.page, "Leituras SA");
  const bia = await personIn(browser, "Bia Só Lê");
  await joinByInvite(ana.page, bia.page);
  const { oid } = await idsOf(ana.page);
  const { uid } = await idsOf(bia.page);
  await patchMember(ana.page, oid!, uid, { permissions: ["deadline.read"], visibility: "all" });
  const id = await officeDeadline(ana.page, "Prazo do escritório lido");
  await bia.page.goto("/app");
  await bia.page.getByLabel("Ambiente").selectOption("personal");
  await bia.page.goto(`/app/prazos/${id}`);
  await expect(bia.page.getByRole("heading", { name: "Prazo de outro ambiente" })).toBeVisible();
  await expect(bia.page.getByText("Prazo do escritório lido")).toHaveCount(0);            // nenhum dado do outro ambiente
  await expect(bia.page.getByRole("button", { name: "Editar prazo" })).toHaveCount(0);
  await expect(bia.page.getByRole("button", { name: "Concluir" })).toHaveCount(0);
  await bia.page.getByRole("button", { name: "Abrir no ambiente do escritório" }).click();  // troca explícita
  await expect(bia.page.getByRole("heading", { name: "Prazo do escritório lido" })).toBeVisible();
  await expect(bia.page.getByLabel("Ambiente")).toHaveValue("office");
  await expect(bia.page.getByRole("button", { name: "Editar prazo" })).toHaveCount(0);   // só leitura: capacidades do recurso
  await expect(bia.page.getByRole("button", { name: "Concluir" })).toHaveCount(0);
  await expect(bia.page.getByLabel("Novo comentário")).toHaveCount(0);
  await ana.context.close();
  await bia.context.close();
});

test("auditoria 6.3: inverso — prazo pessoal com o escritório selecionado; ações funcionam no ambiente correto", async ({ browser }) => {
  const ana = await personIn(browser, "Ana Inverso");
  await createOfficeVia(ana.page, "Inversos Ltda");
  await ana.page.getByLabel("Ambiente").selectOption("personal");
  const id = await newDeadline(ana.page, { title: "Pessoal da Ana", due: "2026-11-20" });
  await ana.page.getByLabel("Ambiente").selectOption("office");
  await ana.page.goto(`/app/prazos/${id}`);
  await expect(ana.page.getByRole("heading", { name: "Prazo de outro ambiente" })).toBeVisible();
  await expect(ana.page.getByText("Pessoal da Ana")).toHaveCount(0);
  await ana.page.getByRole("button", { name: "Abrir no ambiente pessoal" }).click();
  await expect(ana.page.getByRole("heading", { name: "Pessoal da Ana" })).toBeVisible();
  await ana.page.getByRole("button", { name: "Editar prazo" }).click();
  await ana.page.getByLabel("Título").fill("Pessoal da Ana editado");
  await ana.page.getByRole("button", { name: "Salvar alterações" }).click();
  await expect(ana.page.getByRole("heading", { name: "Pessoal da Ana editado" })).toBeVisible();
  await ana.page.getByRole("button", { name: "Concluir" }).click();
  await ana.page.getByRole("button", { name: "Concluir", exact: true }).last().click();
  await expect(ana.page.getByText("Status: Concluído.")).toBeVisible();
  await ana.context.close();
});

test("auditoria 6.3: troca de ambiente com o formulário aberto descarta formulário e dados", async ({ browser }) => {
  const ana = await personIn(browser, "Ana Troca Form");
  await createOfficeVia(ana.page, "Formulários SA");
  const id = await officeDeadline(ana.page, "Prazo com formulário aberto");
  await ana.page.goto(`/app/prazos/${id}`);
  await ana.page.getByRole("button", { name: "Editar prazo" }).click();
  await ana.page.getByLabel("Título").fill("Rascunho não salvo");
  await ana.page.getByLabel("Ambiente").selectOption("personal");
  await expect(ana.page.getByRole("heading", { name: "Prazo de outro ambiente" })).toBeVisible();
  await expect(ana.page.getByLabel("Título")).toHaveCount(0);
  await expect(ana.page.getByText("Prazo com formulário aberto")).toHaveCount(0);
  await ana.page.getByLabel("Ambiente").selectOption("office");
  await expect(ana.page.getByRole("heading", { name: "Prazo com formulário aberto" })).toBeVisible();
  await expect(ana.page.getByLabel("Título")).toHaveCount(0);                              // rascunho não volta
  await ana.context.close();
});

test("auditoria 6.3: detalhe aberto, perda de deadline.read e resposta antiga pausada", async ({ browser }) => {
  const ana = await personIn(browser, "Ana Detalhe");
  await createOfficeVia(ana.page, "Detalhes SA");
  const bia = await personIn(browser, "Bia Detalhe");
  await joinByInvite(ana.page, bia.page);
  const { oid } = await idsOf(ana.page);
  const { uid } = await idsOf(bia.page);
  await patchMember(ana.page, oid!, uid, { visibility: "all" });
  const id = await officeDeadline(ana.page, "Detalhe confidencial");
  await bia.page.goto(`/app/prazos/${id}`);
  await expect(bia.page.getByRole("heading", { name: "Detalhe confidencial" })).toBeVisible();
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  let held = 0;
  await bia.page.route(`**/bff/api/deadlines/${id}`, async (route) => {
    if (held === 0 && route.request().method() === "GET") { held++; const resp = await route.fetch(); await gate; await route.fulfill({ response: resp }).catch(() => {}); }
    else await route.continue();
  });
  await bia.page.reload();                                                                  // nova consulta (fica pausada)
  await expect.poll(() => held).toBe(1);
  await patchMember(ana.page, oid!, uid, { permissions: ["deadline.create"] });
  await bia.page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(bia.page.getByText("Você não tem a permissão “Ver prazos”")).toBeVisible();
  release();
  await bia.page.waitForLoadState("networkidle");
  await expect(bia.page.getByText("Detalhe confidencial")).toHaveCount(0);
  await expect(bia.page).not.toHaveURL(/\/login$/);
  await ana.context.close();
  await bia.context.close();
});
