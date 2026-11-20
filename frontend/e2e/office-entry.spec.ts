// E2E — descoberta dos ambientes pessoal/escritório no MODO INTEGRADO (doc 26).
// Navegador real + BFF + FastAPI + PostgreSQL reais. Uma conta só: o mesmo login acessa o ambiente
// pessoal e, com vínculo, o do escritório. Os demais cenários (segundo escritório recusado, remoção,
// duas abas, permissões de membro e gestor, privacidade dos prazos pessoais, respostas antigas) já
// estão em org.spec.ts, deadlines.spec.ts e intimations.spec.ts e não são duplicados aqui.
// Sem sleep, force, retries ou timeouts maiores; nada de token, link de convite, senha ou cookie
// nas mensagens.
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { createOfficeVia, personIn } from "./helpers";

test.describe.configure({ mode: "serial" });

const MEMBERSHIP = /\/bff\/api\/memberships\/me$/;
const env = (page: Page) => page.getByLabel("Ambiente");
const nav = (page: Page) => page.getByRole("navigation", { name: "Navegação principal" });

async function personalOnly(browser: Parameters<typeof personIn>[0], name: string) {
  const p = await personIn(browser, name);
  await p.page.getByRole("button", { name: "Usar ambiente pessoal" }).click();
  await expect(p.page).toHaveURL(/\/app$/);
  return p;
}

test("sem escritório: 'Escritório' na navegação mostra como criar ou entrar; criar pelo caminho apresentado", async ({ browser }) => {
  const bruno = await personalOnly(browser, "Bruno Sem Vínculo");
  const page = bruno.page;
  await expect(env(page)).toHaveValue("personal");
  await expect(env(page).locator("option")).toHaveCount(1);                       // só "Pessoal": não há vínculo
  await expect(nav(page).getByRole("link", { name: "Equipe" })).toHaveCount(0);

  await expect(nav(page).getByRole("link", { name: "Escritório" })).toBeVisible();     // entrada mesmo sem vínculo
  await nav(page).getByRole("link", { name: "Escritório" }).click();
  await expect(page).toHaveURL(/\/app\/escritorio$/);
  await expect(page.getByText("Você não pertence a um escritório no momento.")).toBeVisible();
  await expect(page.getByRole("link", { name: "Solicitar ingresso com código" })).toHaveAttribute("href", "/solicitar-ingresso");
  await page.goto("/app/escritorio/equipe");                                        // URL direta: mesmas saídas
  await expect(page.getByRole("link", { name: "Criar escritório" })).toBeVisible();

  await page.getByRole("link", { name: "Criar escritório" }).click();
  await expect(page).toHaveURL(/\/onboarding$/);
  await createOfficeVia(page, "Bruno & Associados");
  await expect(page.getByRole("heading", { name: "Bruno & Associados" })).toBeVisible();
  await expect(env(page)).toHaveValue("office");
  await expect(page.getByRole("button", { name: "Gerar link de convite" })).toBeVisible();   // administrador
  await bruno.context.close();
});

test("com escritório no ambiente pessoal: troca explícita; recarga e URL direta respeitam o contexto", async ({ browser }) => {
  const ana = await personIn(browser, "Ana Alterna");
  await createOfficeVia(ana.page, "Alterna Advocacia");
  const page = ana.page;
  await expect(env(page)).toHaveValue("office");

  await env(page).selectOption("personal");                                         // escritório → pessoal
  await nav(page).getByRole("link", { name: "Escritório" }).click();
  await expect(page.getByText("Você está no ambiente pessoal.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Gerar link de convite" })).toHaveCount(0);   // nada do escritório
  await page.reload();
  await expect(env(page)).toHaveValue("personal");                                  // a escolha sobrevive à recarga
  await expect(page.getByRole("button", { name: "Abrir ambiente do escritório" })).toBeVisible();
  await page.getByRole("button", { name: "Abrir ambiente do escritório" }).click(); // pessoal → escritório
  await expect(env(page)).toHaveValue("office");
  await expect(page.getByRole("heading", { name: "Alterna Advocacia" })).toBeVisible();

  await page.goto("/app/escritorio/equipe");                                        // URL direta no escritório
  await expect(page.getByRole("heading", { name: "Equipe" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Sair do escritório" })).toBeVisible();
  await env(page).selectOption("personal");                                         // escritório → pessoal de novo
  await expect(page.getByText("Você está no ambiente pessoal.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Sair do escritório" })).toHaveCount(0);
  await page.goto("/app/prazos");
  await expect(page.getByText("Ambiente pessoal").first()).toBeVisible();          // o ambiente ativo é informado
  await ana.context.close();
});

test("ingresso pelo caminho apresentado: código → aprovação → membro só com o permitido; segundo vínculo recusado", async ({ browser }) => {
  const ana = await personIn(browser, "Ana Aprova Caminho");
  await createOfficeVia(ana.page, "Caminho Ltda");
  const code = (await ana.page.getByTestId("join-code").textContent())!.trim();

  const caio = await personalOnly(browser, "Caio Caminho");
  await expect(nav(caio.page).getByRole("link", { name: "Escritório" })).toBeVisible();
  await nav(caio.page).getByRole("link", { name: "Escritório" }).click();
  await expect(caio.page.getByRole("link", { name: "Solicitar ingresso com código" })).toBeVisible();
  await caio.page.getByRole("link", { name: "Solicitar ingresso com código" }).click();
  await expect(caio.page).toHaveURL(/\/solicitar-ingresso$/);
  await caio.page.getByLabel("Código de ingresso").fill(code);
  await caio.page.getByRole("button", { name: "Solicitar ingresso" }).click();
  await expect(caio.page.getByText("Solicitação enviada para “Caminho Ltda”")).toBeVisible();

  await ana.page.reload();
  await ana.page.getByRole("button", { name: "Aprovar" }).click();
  await ana.page.getByRole("button", { name: "Aprovar", exact: true }).last().click();
  await expect(ana.page.getByText("Solicitação aprovada.")).toBeVisible();

  // Caio escolheu "Usar ambiente pessoal" no início: essa preferência de navegação (por aba) é mantida
  // depois do ingresso. A tela do escritório oferece a troca explícita em vez de um aviso sem saída.
  await caio.page.goto("/app/escritorio");
  await expect(caio.page.getByText("Você está no ambiente pessoal.")).toBeVisible();
  await expect(caio.page.getByRole("button", { name: "Abrir ambiente do escritório" })).toBeVisible();
  await caio.page.getByRole("button", { name: "Abrir ambiente do escritório" }).click();
  await expect(caio.page.getByRole("heading", { name: "Caminho Ltda" })).toBeVisible();
  await expect(env(caio.page)).toHaveValue("office");
  await expect(caio.page.getByText("Somente quem gere o escritório pode alterar o nome.")).toBeVisible();
  await expect(caio.page.getByRole("button", { name: "Gerar link de convite" })).toHaveCount(0);  // membro
  await caio.page.goto("/solicitar-ingresso");
  await expect(caio.page.getByText("Você já pertence ao escritório “Caminho Ltda”")).toBeVisible();
  await expect(caio.page.getByRole("button", { name: "Solicitar ingresso" })).toHaveCount(0);
  await caio.page.goto("/onboarding");
  await expect(caio.page.getByRole("heading", { name: "Você já pertence a um escritório" })).toBeVisible();
  await ana.context.close();
  await caio.context.close();
});

test("vínculo pendente ou com erro: nunca 'sem escritório' por engano; erro visível com nova tentativa", async ({ browser }) => {
  const ana = await personIn(browser, "Ana Espera");
  await createOfficeVia(ana.page, "Espera & Erro");
  const page = ana.page;

  // 1) Resposta REAL retida: enquanto carrega, a tela não afirma ausência de vínculo.
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  let reached!: () => void;
  const arrived = new Promise<void>((r) => { reached = r; });
  let first = true;
  await page.route(MEMBERSHIP, async (route) => {
    if (!first) return route.continue();
    first = false;
    const resp = await route.fetch();
    reached();
    await gate;
    await route.fulfill({ response: resp }).catch(() => {});
  });
  await page.goto("/app/escritorio");
  await arrived;
  await expect(page.getByText("Carregando…").first()).toBeVisible();
  await expect(page.getByText("Você não pertence a um escritório no momento.")).toHaveCount(0);
  release();
  await expect(page.getByRole("heading", { name: "Espera & Erro" })).toBeVisible();
  await page.unroute(MEMBERSHIP);

  // 2) Erro SIMULADO (429 no vínculo): aviso visível e "Tentar novamente", sem carregamento eterno.
  await page.route(MEMBERSHIP, (route) => route.fulfill({
    status: 429, contentType: "application/json", headers: { "retry-after": "1" },
    body: JSON.stringify({ error: { code: "rate_limited", message: "Muitas solicitações." } }),
  }));
  await page.reload();
  await expect(page.getByRole("alert").filter({ hasText: "Não foi possível carregar o vínculo com escritório." })).toBeVisible();
  await expect(page.getByText("Você não pertence a um escritório no momento.")).toHaveCount(0);
  await expect(page.getByText("Espera & Erro")).toHaveCount(0);                      // nada de dado anterior
  await page.unroute(MEMBERSHIP);
  await page.getByRole("button", { name: "Tentar novamente" }).click();
  await expect(page.getByRole("heading", { name: "Espera & Erro" })).toBeVisible();
  await ana.context.close();
});
