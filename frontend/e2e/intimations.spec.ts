// E2E 6.4 — intimações (somente metadados, revisão humana) e notificações internas:
// navegador real + Next (build integrado) + FastAPI real. Cada contexto = um cliente (IP próprio).
import { type Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { BACKEND, backendToken, createOfficeVia, idsOf, joinByInvite, patchMember, personIn } from "./helpers";

test.describe.configure({ mode: "serial" });
const MEMBER = ["deadline.read", "deadline.create", "deadline.edit", "deadline.complete"];
const FORBIDDEN_TEXTS = ["PDF enviado", "análise concluída", "extraído por IA", "Extraído por IA"];

async function registerViaUi(page: Page, f: { file: string; kb?: string; received?: string; suggested?: string }) {
  await page.goto("/app/intimacoes/upload");
  await page.getByLabel("Nome do arquivo (.pdf)").fill(f.file);
  await page.getByLabel("Tamanho declarado (KB)").fill(f.kb ?? "120");
  await page.getByLabel("Recebida em").fill(f.received ?? "2026-11-03");
  if (f.suggested) await page.getByLabel("Responsável sugerido (opcional)").selectOption({ label: f.suggested });
  await page.getByRole("button", { name: "Registrar metadados" }).click();
  await expect(page).toHaveURL(/\/app\/intimacoes\/(?!upload$)[A-Za-z0-9_-]+$/);   // detalhe, não o formulário
  return page.url().split("/").pop()!;
}

async function fillConfirm(page: Page, f: { title: string; responsible?: string }) {
  const form = page.getByRole("form", { name: "Confirmar intimação" });
  await form.getByLabel("Título").fill(f.title);
  await form.getByLabel("Número do processo").fill("0001234-56.2026");
  await form.getByLabel("Tribunal / vara").fill("TJSC 3ª Vara");
  await form.getByLabel("Área de atuação").fill("Cível");
  if (f.responsible) await form.getByLabel("Responsável").selectOption({ label: f.responsible });
  await form.getByLabel("Início").fill("2026-11-03");
  await form.getByLabel("Vencimento").fill("2026-11-24");
  await form.getByLabel("Duração em dias (referência)").fill("15");
  await form.getByLabel(/Revisei manualmente/).check();
  return form;
}

async function confirmViaUi(page: Page, f: { title: string; responsible?: string }) {
  const form = await fillConfirm(page, f);
  await form.getByRole("button", { name: "Confirmar e criar prazo" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Confirmar e criar prazo" }).click();
}

/** Fixture pela API EXISTENTE do backend (conta de teste). */
async function api(email: string, method: string, path: string, body?: unknown) {
  const token = await backendToken(email);
  const r = await fetch(`${BACKEND}/api/v1${path}`, { method, headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: r.status === 204 ? null : await r.json() };
}
const FINAL = { caseNumber: "0001234-56.2026", court: "TJSC", practiceArea: "Cível", priority: "normal", startDate: "2026-11-01",
  dueDate: "2026-11-20", countingMode: "business", duration: 10 };

test("pessoal: metadados sem arquivo, rascunho null × omissão, confirmação explícita sem duplicar", async ({ browser }) => {
  const ana = await personIn(browser, "Ana Intimações");
  await ana.page.getByRole("button", { name: "Usar ambiente pessoal" }).click();
  const posts: Array<{ url: string; body: string }> = [];
  const urls: string[] = [];
  ana.page.on("request", (r) => { urls.push(r.url()); if (r.method() !== "GET") posts.push({ url: r.url(), body: r.postData() ?? "" }); });
  const id = await registerViaUi(ana.page, { file: "intimacao-contestacao.pdf" });
  const reg = posts.find((p) => p.url.endsWith("/bff/api/intimations"))!;
  expect(Object.keys(JSON.parse(reg.body)).sort()).toEqual(["contentType", "fileName", "receivedAt", "scope", "sizeBytes"]);   // sem bytes
  await expect(ana.page.getByText("não é enviado nem armazenado").first()).toBeVisible();
  await expect(ana.page.getByTestId("storage")).toHaveText("Não armazenado (somente metadados)");
  await expect(ana.page.getByTestId("processing")).toHaveText("Indisponível nesta fase (sem OCR/IA)");
  for (const t of FORBIDDEN_TEXTS) await expect(ana.page.getByText(t)).toHaveCount(0);

  const draft = ana.page.getByRole("form", { name: "Rascunho da intimação" });
  await draft.getByLabel("Título").fill("Contestação do rascunho");
  await draft.getByLabel("Horário (opcional)").fill("09:30");
  await draft.getByRole("button", { name: "Salvar rascunho" }).click();
  await expect(ana.page.getByText("Rascunho salvo.")).toBeVisible();
  await draft.getByLabel("Horário (opcional)").fill("");
  await draft.getByRole("button", { name: "Salvar rascunho" }).click();
  await expect(ana.page.getByText("Rascunho salvo.")).toBeVisible();
  const patches = posts.filter((p) => p.url.endsWith(`/intimations/${id}`)).map((p) => JSON.parse(p.body));
  expect(patches[0]).toEqual({ version: 1, title: "Contestação do rascunho", agendaTime: "09:30" });
  expect(patches[1]).toEqual({ version: 2, agendaTime: null });                          // null limpa; título omitido = mantido

  await confirmViaUi(ana.page, { title: "Contestação confirmada" });
  await expect(ana.page.getByTestId("confirm-result")).toContainText("Revisão confirmada: prazo criado.");
  const confirm = posts.find((p) => p.url.endsWith("/confirm"))!;
  expect(Object.keys(JSON.parse(confirm.body)).sort()).toEqual(
    ["agendaTime", "caseNumber", "countingMode", "court", "dueDate", "duration", "practiceArea", "priority", "responsibleId", "startDate", "title", "version"]);
  await expect(ana.page.getByText("Revisada")).toBeVisible();
  await expect(ana.page.getByRole("form", { name: "Confirmar intimação" })).toHaveCount(0);         // terminal
  await ana.page.getByTestId("linked").getByRole("link").click();
  await expect(ana.page.getByRole("heading", { name: "Contestação confirmada" })).toBeVisible();
  await expect(ana.page.getByTestId("due-date")).toHaveText("24/11/2026");
  const total = await ana.page.evaluate(async () => (await (await fetch("/bff/api/deadlines?scope=personal", { headers: { "x-prazoai-csrf": "1" } })).json()).total);
  expect(total).toBe(1);
  const storage = await ana.page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }));
  expect(storage).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}|JVBERi/);
  expect(urls.some((u) => /eyJ[A-Za-z0-9_-]{10,}|JVBERi/.test(u))).toBe(false);
  await ana.context.close();
});

test("rascunho em duas abas: conflito preserva o texto; nova confirmação explícita", async ({ browser }) => {
  const ana = await personIn(browser, "Ana Duas Abas");
  await ana.page.getByRole("button", { name: "Usar ambiente pessoal" }).click();
  const id = await registerViaUi(ana.page, { file: "conflito.pdf" });
  const tabB = await ana.context.newPage();
  await tabB.goto(`/app/intimacoes/${id}`);
  await expect(tabB.getByRole("heading", { name: "conflito.pdf" })).toBeVisible();      // aba B leu a versão 1
  const a = ana.page.getByRole("form", { name: "Rascunho da intimação" });
  await a.getByLabel("Título").fill("Título da aba A");
  await a.getByRole("button", { name: "Salvar rascunho" }).click();
  await expect(ana.page.getByText("Rascunho salvo.")).toBeVisible();
  let patches = 0;
  tabB.on("request", (r) => { if (r.method() === "PATCH") patches++; });
  const b = tabB.getByRole("form", { name: "Rascunho da intimação" });
  await b.getByLabel("Título").fill("Título da aba B");
  await b.getByRole("button", { name: "Salvar rascunho" }).click();
  await expect(tabB.getByText("foi alterado por outra pessoa ou aba")).toBeVisible();
  await expect(b.getByLabel("Título")).toHaveValue("Título da aba B");
  expect(patches).toBe(1);
  await b.getByRole("button", { name: /Carregar versão atual/ }).click();
  await expect(tabB.getByRole("heading", { name: "Título da aba A" })).toBeVisible();
  await expect(b.getByLabel("Título")).toHaveValue("Título da aba B");
  await b.getByRole("button", { name: "Salvar rascunho" }).click();
  await expect(tabB.getByRole("heading", { name: "Título da aba B" })).toBeVisible();
  expect(patches).toBe(2);
  await ana.context.close();
});

test("escritório: assigned × all, responsável atual após reatribuição e vínculo sem leitura", async ({ browser }) => {
  const ana = await personIn(browser, "Ana Gestora Intim");
  await createOfficeVia(ana.page, "Intimações SA");
  const bia = await personIn(browser, "Bia Sugerida");
  await joinByInvite(ana.page, bia.page);
  const caio = await personIn(browser, "Caio Atual");
  await joinByInvite(ana.page, caio.page);
  const id = await registerViaUi(ana.page, { file: "sugerida-bia.pdf", suggested: "Bia Sugerida" });
  await bia.page.goto("/app/intimacoes");
  await expect(bia.page.getByRole("link", { name: "sugerida-bia.pdf" })).toBeVisible();
  await caio.page.goto("/app/intimacoes");
  await expect(caio.page.getByTestId("intimation-count")).toHaveText("0 intimação(ões)");           // assigned sem vínculo
  await ana.page.goto(`/app/intimacoes/${id}`);
  await confirmViaUi(ana.page, { title: "Prazo da Bia", responsible: "Bia Sugerida" });
  await expect(ana.page.getByTestId("confirm-result")).toContainText("prazo criado");
  await bia.page.goto(`/app/intimacoes/${id}`);
  await expect(bia.page.getByRole("heading", { name: "sugerida-bia.pdf" })).toBeVisible();
  // Reatribuição do prazo vinculado: a leitura passa ao responsável ATUAL.
  await ana.page.getByTestId("linked").getByRole("link").click();
  await ana.page.getByRole("button", { name: "Editar prazo" }).click();
  await ana.page.getByLabel("Responsável").selectOption({ label: "Caio Atual" });
  await ana.page.getByRole("button", { name: "Salvar alterações" }).click();
  await expect(ana.page.getByTestId("responsible")).toHaveText("Caio Atual");
  await bia.page.reload();
  await expect(bia.page.getByText("Você não tem acesso a esta área ou ela não existe mais.")).toBeVisible();
  await caio.page.goto(`/app/intimacoes/${id}`);
  await expect(caio.page.getByTestId("linked").getByRole("link", { name: "Abrir o prazo vinculado" })).toBeVisible();
  // Vínculo existente sem deadlineId legível: autora com visibilidade restrita.
  const own = await registerViaUi(bia.page, { file: "autora-bia.pdf", suggested: "Bia Sugerida" });
  const cur = await api(ana.email, "GET", `/intimations/${own}`);
  const { uid: caioId } = await idsOf(caio.page);
  expect((await api(ana.email, "POST", `/intimations/${own}/confirm`, { version: cur.body.version, title: "Para o Caio", responsibleId: caioId, ...FINAL })).status).toBe(201);
  await bia.page.goto(`/app/intimacoes/${own}`);
  await expect(bia.page.getByTestId("linked")).toHaveText("Existe um prazo vinculado, mas você não tem permissão para vê-lo.");
  await expect(bia.page.getByTestId("linked").getByRole("link")).toHaveCount(0);
  await expect(bia.page.getByText("vínculo sem permissão de leitura para você")).toBeVisible();     // histórico legível
  for (const c of [ana, bia, caio]) await c.context.close();
});

test("URL direta de intimação de outro ambiente: sem dados; troca explícita", async ({ browser }) => {
  const ana = await personIn(browser, "Ana Ambientes Intim");
  await createOfficeVia(ana.page, "Ambientes Intim");
  const id = await registerViaUi(ana.page, { file: "do-escritorio.pdf" });
  await ana.page.getByLabel("Ambiente").selectOption("personal");
  await ana.page.goto(`/app/intimacoes/${id}`);
  await expect(ana.page.getByRole("heading", { name: "Intimação de outro ambiente" })).toBeVisible();
  await expect(ana.page.getByText("do-escritorio.pdf")).toHaveCount(0);
  await ana.page.getByRole("button", { name: "Abrir no ambiente do escritório" }).click();
  await expect(ana.page.getByRole("heading", { name: "do-escritorio.pdf" })).toBeVisible();
  await ana.context.close();
});

test("descarte e estado terminal; confirmação com resultado desconhecido não é repetida", async ({ browser }) => {
  const ana = await personIn(browser, "Ana Descarta");
  await ana.page.getByRole("button", { name: "Usar ambiente pessoal" }).click();
  const gone = await registerViaUi(ana.page, { file: "descartar.pdf" });
  await ana.page.getByRole("button", { name: "Descartar intimação" }).click();
  await ana.page.getByRole("dialog").getByRole("button", { name: "Descartar" }).click();
  await expect(ana.page.getByText("Intimação descartada: não pode ser editada")).toBeVisible();
  await expect(ana.page.getByRole("form", { name: "Confirmar intimação" })).toHaveCount(0);
  await ana.page.goto("/app/intimacoes");
  await expect(ana.page.getByRole("link", { name: "descartar.pdf" })).toHaveCount(0);
  await ana.page.getByLabel("Status").selectOption("discarded");
  await expect(ana.page.getByRole("link", { name: "descartar.pdf" })).toBeVisible();
  expect(gone).toBeTruthy();

  const id = await registerViaUi(ana.page, { file: "instavel.pdf" });
  let confirms = 0;
  await ana.page.route(`**/bff/api/intimations/${id}/confirm`, async (route) => {
    confirms++;
    await route.fetch();                                   // o servidor confirma…
    await route.abort("connectionreset");                  // …e a resposta se perde
  });
  await confirmViaUi(ana.page, { title: "Prazo instável" });
  await expect(ana.page.getByText("ela pode ter ocorrido")).toBeVisible();
  expect(confirms).toBe(1);
  await ana.page.getByRole("button", { name: "Conferir situação da intimação" }).click();
  await expect(ana.page.getByText("Revisada")).toBeVisible();
  expect(confirms).toBe(1);
  const total = await ana.page.evaluate(async () => (await (await fetch("/bff/api/deadlines?scope=personal", { headers: { "x-prazoai-csrf": "1" } })).json()).total);
  expect(total).toBe(1);
  await ana.context.close();
});

test("recusa deixar pendência sem responsável operacional; rascunho preservado", async ({ browser }) => {
  const ana = await personIn(browser, "Ana Operacional");
  await createOfficeVia(ana.page, "Operacional SA");
  const bia = await personIn(browser, "Bia Autora");
  await joinByInvite(ana.page, bia.page);
  const caio = await personIn(browser, "Caio Recebe");
  await joinByInvite(ana.page, caio.page);
  const id = await registerViaUi(bia.page, { file: "da-autora.pdf", suggested: "Bia Autora" });
  const { oid } = await idsOf(ana.page);
  const { uid: biaId } = await idsOf(bia.page);
  const { uid: caioId } = await idsOf(caio.page);
  expect((await api(ana.email, "POST", `/offices/${oid}/members/${biaId}/remove`, { reassignTo: caioId })).status).toBe(204);
  await ana.page.goto(`/app/intimacoes/${id}`);
  await expect(ana.page.getByTestId("suggested")).toHaveText("Caio Recebe");
  const draft = ana.page.getByRole("form", { name: "Rascunho da intimação" });
  await draft.getByLabel("Título").fill("Título que não pode se perder");
  await draft.getByLabel("Responsável sugerido").selectOption("");
  await draft.getByRole("button", { name: "Salvar rascunho" }).click();
  await expect(ana.page.getByText("precisa de um responsável sugerido")).toBeVisible();
  await expect(draft.getByLabel("Título")).toHaveValue("Título que não pode se perder");
  await expect(ana.page.getByTestId("suggested")).toHaveText("Caio Recebe");
  for (const c of [ana, bia, caio]) await c.context.close();
});

test("notificações: contador do servidor, marcar uma, marcar todas além da 1ª página e só no ambiente escolhido", async ({ browser }) => {
  const ana = await personIn(browser, "Ana Notifica");
  await createOfficeVia(ana.page, "Notificações SA");
  const bia = await personIn(browser, "Bia Notificada");
  await joinByInvite(ana.page, bia.page);
  const { uid: biaId } = await idsOf(bia.page);
  for (let n = 0; n < 25; n++) {
    expect((await api(ana.email, "POST", "/deadlines", { scope: "office", title: `Atribuído ${String(n).padStart(2, "0")}`, responsibleId: biaId, ...FINAL })).status).toBe(201);
  }
  await bia.page.goto("/app/notificacoes");
  await expect(bia.page.getByTestId("unread-badge")).toHaveText(" (25)");
  await expect(bia.page.getByTestId("notification-count")).toHaveText("25 notificação(ões) · 25 não lida(s)");
  await expect(bia.page.getByTestId("notification")).toHaveCount(20);
  await expect(bia.page.getByTestId("retention")).toContainText("retenção");
  await bia.page.getByTestId("notification").first().getByRole("button", { name: "Marcar como lida" }).click();
  await expect(bia.page.getByTestId("unread-badge")).toHaveText(" (24)");
  // Outro ambiente: marcar todas no pessoal não toca o escritório.
  const marked = await bia.page.evaluate(async () => (await (await fetch("/bff/api/notifications/read-all?scope=personal", {
    method: "POST", headers: { "x-prazoai-csrf": "1", "content-type": "application/json" }, body: "{}" })).json()).marked);
  expect(marked).toBe(0);
  await bia.page.getByRole("button", { name: "Atualizar" }).click();
  await expect(bia.page.getByTestId("unread-badge")).toHaveText(" (24)");
  await bia.page.getByRole("button", { name: "Marcar todas como lidas" }).click();
  await expect(bia.page.getByText("24 notificação(ões) marcada(s) como lida(s).")).toBeVisible();
  await expect(bia.page.getByTestId("unread-badge")).toHaveCount(0);
  await bia.page.getByRole("button", { name: "Página 2" }).click();
  await expect(bia.page.getByTestId("notification")).toHaveCount(5);
  await expect(bia.page.getByTestId("notification").getByText("Nova")).toHaveCount(0);              // 2ª página também lida
  await bia.page.getByTestId("notification").first().getByRole("link", { name: "Abrir" }).click();
  await expect(bia.page).toHaveURL(/\/app\/prazos\/[A-Za-z0-9_-]+$/);
  await bia.page.getByLabel("Ambiente").selectOption("personal");
  await bia.page.goto("/app/notificacoes");
  await expect(bia.page.getByText("nesta etapa não há notificações pessoais")).toBeVisible();
  await ana.context.close();
  await bia.context.close();
});

test("notificações e contador: perda de acesso com resposta antiga pausada; recuperação", async ({ browser }) => {
  const ana = await personIn(browser, "Ana Revoga Notif");
  await createOfficeVia(ana.page, "Revoga Notif");
  const bia = await personIn(browser, "Bia Perde Notif");
  await joinByInvite(ana.page, bia.page);
  const { oid } = await idsOf(ana.page);
  const { uid: biaId } = await idsOf(bia.page);
  expect((await api(ana.email, "POST", "/deadlines", { scope: "office", title: "Prazo notificado sigiloso", responsibleId: biaId, ...FINAL })).status).toBe(201);
  await bia.page.goto("/app/notificacoes");
  await expect(bia.page.getByText(/Prazo notificado sigiloso/)).toBeVisible();
  await expect(bia.page.getByTestId("unread-badge")).toHaveText(" (1)");
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  let held = 0;
  await bia.page.route(/\/bff\/api\/notifications(\/unread-count)?\?/, async (route) => {
    if (held < 2) { held++; const resp = await route.fetch(); await gate; await route.fulfill({ response: resp }).catch(() => {}); }
    else await route.continue();
  });
  await bia.page.getByRole("button", { name: "Atualizar" }).click();                // lista + contador (pausados)
  await expect.poll(() => held).toBe(2);
  await patchMember(ana.page, oid!, biaId, { permissions: ["deadline.create"] });    // perde deadline.read
  await bia.page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(bia.page.getByTestId("notification-count")).toHaveText("0 notificação(ões) · 0 não lida(s)");
  release();
  await bia.page.waitForLoadState("networkidle");
  await expect(bia.page.getByText(/Prazo notificado sigiloso/)).toHaveCount(0);
  await expect(bia.page.getByTestId("unread-badge")).toHaveCount(0);
  await expect(bia.page).not.toHaveURL(/\/login$/);
  await bia.page.unroute(/\/bff\/api\/notifications(\/unread-count)?\?/);
  await patchMember(ana.page, oid!, biaId, { permissions: MEMBER });                 // recupera
  await bia.page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(bia.page.getByText(/Prazo notificado sigiloso/)).toBeVisible();
  await expect(bia.page.getByTestId("unread-badge")).toHaveText(" (1)");
  await ana.context.close();
  await bia.context.close();
});

// ---------------------------------------------------------------- auditoria da 6.4
test("auditoria 6.4: confirmação pausada + reatribuição — mensagem preservada, vínculo protegido, nenhum link antigo", async ({ browser }) => {
  const ana = await personIn(browser, "Ana Reatribui Gate");
  await createOfficeVia(ana.page, "Gate Confirmação");
  const bia = await personIn(browser, "Bia Autora Gate");
  await joinByInvite(ana.page, bia.page);
  const caio = await personIn(browser, "Caio Recebe Gate");
  await joinByInvite(ana.page, caio.page);
  const { uid: caioId } = await idsOf(caio.page);
  const id = await registerViaUi(bia.page, { file: "gate.pdf", suggested: "Bia Autora Gate" });
  let deadlineId = "";
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  await bia.page.route(`**/bff/api/intimations/${id}/confirm`, async (route) => {
    const resp = await route.fetch();                                   // o servidor confirma e cria o prazo da Bia
    deadlineId = (await resp.json()).deadline.id;
    await gate;                                                         // resposta pausada
    await route.fulfill({ response: resp });
  });
  await confirmViaUi(bia.page, { title: "Prazo reatribuído no meio" });
  await expect.poll(() => deadlineId).not.toBe("");
  const d = await api(ana.email, "GET", `/deadlines/${deadlineId}`);
  expect((await api(ana.email, "PATCH", `/deadlines/${deadlineId}`, { version: d.body.version, responsibleId: caioId })).status).toBe(200);
  release();                                                            // resposta antiga (com o id) chega depois
  await expect(bia.page.getByTestId("confirm-result")).toContainText("Revisão confirmada: prazo criado.");   // mensagem preservada
  await expect(bia.page.getByTestId("linked")).toHaveText("Existe um prazo vinculado, mas você não tem permissão para vê-lo.");
  await expect(bia.page.getByTestId("confirm-result").getByRole("link")).toHaveCount(0);
  await expect(bia.page.locator(`a[href*="${deadlineId}"]`)).toHaveCount(0);
  expect(await bia.page.content()).not.toContain(deadlineId);           // nenhum trecho com o id antigo
  await bia.page.unroute(`**/bff/api/intimations/${id}/confirm`);
  for (const c of [ana, bia, caio]) await c.context.close();
});

test("auditoria 6.4: acesso mantido — o link do resultado e do vínculo funciona", async ({ browser }) => {
  const ana = await personIn(browser, "Ana Mantém Acesso");
  await createOfficeVia(ana.page, "Acesso Mantido");
  const bia = await personIn(browser, "Bia Mantém Acesso");
  await joinByInvite(ana.page, bia.page);
  await registerViaUi(bia.page, { file: "mantem.pdf", suggested: "Bia Mantém Acesso" });
  await confirmViaUi(bia.page, { title: "Prazo que continua da Bia" });
  await expect(bia.page.getByTestId("confirm-result")).toContainText("Revisão confirmada: prazo criado.");
  await expect(bia.page.getByTestId("linked").getByRole("link", { name: "Abrir o prazo vinculado" })).toBeVisible();
  await bia.page.getByTestId("confirm-result").getByRole("link", { name: "Abrir o prazo" }).click();
  await expect(bia.page.getByRole("heading", { name: "Prazo que continua da Bia" })).toBeVisible();
  await expect(bia.page.getByTestId("responsible")).toHaveText("Bia Mantém Acesso (você)");
  await ana.context.close();
  await bia.context.close();
});
