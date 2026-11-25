// Doc 28 — E2E do PDF da intimação: navegador real + Next integrado + FastAPI (PostgreSQL) + Azurite.
// Fluxo: envio do PDF → aviso de preenchimento manual → download idêntico → revisão manual → confirmação →
// prazo vinculado → PDF recuperado a partir do prazo. Só PDFs sintéticos.
import { readFileSync } from "node:fs";
import { expect, test } from "./fixtures";
import { personIn } from "./helpers";
import { syntheticPdf } from "../tests/helpers/pdf.mjs";

test.describe.configure({ mode: "serial" });

const NOTICE = "Preencha os dados do documento. Leitura automática ainda não disponível.";

test("PDF: envio → download idêntico → preenchimento manual → confirmação → prazo vinculado → download", async ({ browser }) => {
  const ana = await personIn(browser, "Ana PDF");
  await ana.page.getByRole("button", { name: "Usar ambiente pessoal" }).click();
  const pdf = syntheticPdf({ payload: `% e2e ${Date.now()}` });

  await ana.page.goto("/app/intimacoes/upload");
  await expect(ana.page.getByText(NOTICE)).toBeVisible();
  await ana.page.getByLabel("Arquivo PDF (até 10 MiB)").setInputFiles({ name: "intimação sintética.pdf", mimeType: "application/pdf", buffer: pdf });
  await ana.page.getByLabel("Recebida em").fill("2026-11-20");
  await ana.page.getByRole("button", { name: "Registrar e enviar PDF" }).click();
  await expect(ana.page).toHaveURL(/\/app\/intimacoes\/(?!upload$)[A-Za-z0-9_-]+$/);
  const intimationId = ana.page.url().split("/").pop()!;
  await expect(ana.page.getByText(NOTICE)).toBeVisible();
  await expect(ana.page.getByTestId("storage")).toContainText("Armazenado em local privado");
  await expect(ana.page.getByText("intimação sintética.pdf").first()).toBeVisible();
  for (const t of ["análise concluída", "extraído por IA", "Extraído por IA", "livre de malware", "Processando"]) {
    await expect(ana.page.getByText(t)).toHaveCount(0);
  }

  // download pelo detalhe: bytes iguais e nome do anexo
  const [download] = await Promise.all([
    ana.page.waitForEvent("download"),
    ana.page.getByTestId("storage").getByRole("button", { name: "Baixar PDF" }).click(),
  ]);
  expect(download.suggestedFilename()).toBe("intimação sintética.pdf");
  expect(readFileSync((await download.path())!).equals(pdf)).toBe(true);

  // preenchimento manual e confirmação explícita
  const form = ana.page.getByRole("form", { name: "Confirmar intimação" });
  await form.getByLabel("Título").fill("Contestação do PDF");
  await form.getByLabel("Número do processo").fill("0001234-56.2026");
  await form.getByLabel("Tribunal / vara").fill("TJSC 3ª Vara");
  await form.getByLabel("Área de atuação").fill("Cível");
  await form.getByLabel("Início").fill("2026-11-20");
  await form.getByLabel("Vencimento").fill("2026-12-04");
  await form.getByLabel("Duração em dias (referência)").fill("10");
  await form.getByLabel(/Revisei manualmente/).check();
  await form.getByRole("button", { name: "Confirmar e criar prazo" }).click();
  await ana.page.getByRole("dialog").getByRole("button", { name: "Confirmar e criar prazo" }).click();
  await expect(ana.page.getByTestId("confirm-result")).toContainText("Revisão confirmada: prazo criado.");

  // repetição pela API do BFF não cria outro prazo
  const repeat = await ana.page.evaluate(async (id) => {
    const h = { "x-prazoai-csrf": "1", "content-type": "application/json" };
    const i = await (await fetch(`/bff/api/intimations/${id}`, { headers: h })).json();
    const me = (await (await fetch("/bff/session", { headers: h })).json()).user.id;
    const r = await fetch(`/bff/api/intimations/${id}/confirm`, { method: "POST", headers: h, body: JSON.stringify({
      version: i.version, title: "Contestação do PDF", caseNumber: "0001234-56.2026", court: "TJSC 3ª Vara", practiceArea: "Cível",
      priority: "normal", responsibleId: me, startDate: "2026-11-20", dueDate: "2026-12-04", countingMode: "business", duration: 10,
      agendaTime: null }) });
    const total = (await (await fetch("/bff/api/deadlines?scope=personal", { headers: h })).json()).total;
    const body = await r.json();
    return { status: r.status, created: body.created ?? body.error?.code, total };
  }, intimationId);
  expect(repeat).toEqual({ status: 200, created: false, total: 1 });

  // prazo vinculado → intimação de origem → mesmo PDF
  await ana.page.getByTestId("linked").getByRole("link").click();
  await expect(ana.page.getByRole("heading", { name: "Contestação do PDF" })).toBeVisible();
  const card = ana.page.getByTestId("linked-intimation");
  await expect(card).toContainText("intimação sintética.pdf");
  const [again] = await Promise.all([ana.page.waitForEvent("download"), card.getByRole("button", { name: "Baixar PDF" }).click()]);
  expect(readFileSync((await again.path())!).equals(pdf)).toBe(true);
  await card.getByRole("link", { name: "Abrir a intimação" }).click();
  await expect(ana.page).toHaveURL(new RegExp(`/app/intimacoes/${intimationId}$`));

  // nada do PDF em armazenamento do navegador nem em URLs
  const storage = await ana.page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }));
  expect(storage).not.toContain("JVBERi");

  // outra conta, conhecendo o identificador: 404 (sem revelar existência); sem cabeçalho próprio: 403
  const bia = await personIn(browser, "Bia Sem Acesso");
  const statuses = await bia.page.evaluate(async (id) => ({
    withHeader: (await fetch(`/bff/files/intimations/${id}`, { headers: { "x-prazoai-csrf": "1" } })).status,
    plainLink: (await fetch(`/bff/files/intimations/${id}`)).status,
  }), intimationId);
  expect(statuses).toEqual({ withHeader: 404, plainLink: 403 });
  await ana.context.close();
  await bia.context.close();
});

test("PDF inválido pela interface: recusado, intimação fica sem PDF e o envio pode ser repetido", async ({ browser }) => {
  const ana = await personIn(browser, "Ana PDF Inválido");
  await ana.page.getByRole("button", { name: "Usar ambiente pessoal" }).click();
  await ana.page.goto("/app/intimacoes/upload");
  await ana.page.getByLabel("Arquivo PDF (até 10 MiB)").setInputFiles({ name: "falso.pdf", mimeType: "application/pdf", buffer: Buffer.from("isto não é um PDF") });
  await ana.page.getByLabel("Recebida em").fill("2026-11-20");
  await ana.page.getByRole("button", { name: "Registrar e enviar PDF" }).click();
  await expect(ana.page.getByText("O arquivo não é um PDF válido.")).toBeVisible();
  await expect(ana.page.getByTestId("upload-pending")).toContainText("não foi armazenado");
  await ana.page.getByTestId("upload-pending").getByRole("link", { name: "abra a intimação" }).click();
  await expect(ana.page.getByTestId("storage")).toHaveText("PDF não enviado");
  // envio posterior pelo detalhe, agora com um PDF válido
  const pdf = syntheticPdf({ payload: "% depois" });
  const upload = ana.page.getByRole("form", { name: "Enviar PDF da intimação" });
  await upload.getByLabel("Arquivo PDF (até 10 MiB)").setInputFiles({ name: "correto.pdf", mimeType: "application/pdf", buffer: pdf });
  await upload.getByRole("button", { name: "Enviar PDF" }).click();
  await expect(ana.page.getByTestId("storage")).toContainText("Armazenado em local privado");
  await expect(ana.page.getByRole("form", { name: "Enviar PDF da intimação" })).toHaveCount(0);   // 1 por intimação
  await ana.context.close();
});
