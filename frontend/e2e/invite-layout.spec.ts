// E2E — estabilidade do botão "Gerar link de convite" (doc 25; diagnóstico em doc 21 §17.2).
// Navegador real + BFF + FastAPI reais. As rotas interceptadas só RETÊM a resposta verdadeira do
// servidor (`route.fetch()` → gate → `fulfill`) para impor a ordem; nenhum conteúdo é inventado, salvo
// a falha de rede SIMULADA do teste de erro (`route.abort`). Sem sleep, force, retries ou timeouts
// maiores. Nenhuma falha imprime link, token, cookie ou corpo: as asserções usam só contagens,
// posições e textos fixos da interface.
import type { Browser, Page, Route } from "@playwright/test";
import { expect, test } from "./fixtures";
import { createOfficeVia, personIn } from "./helpers";

test.describe.configure({ mode: "serial" });

const INVITE_PATH = /\/bff\/api\/offices\/[^/]+\/invitations$/;
const JOIN_CODE = /\/bff\/api\/offices\/[^/]+\/join-code$/;
const DESKTOP = { width: 1280, height: 800 };
const NARROW = { width: 360, height: 740 };
const INVITE = { name: "Gerar link de convite" } as const;
const LINK_LABEL = "Link do convite (exibido só agora)";

type Counters = { submit: number; buttonClick: number };

/** Administrador com escritório recém-criado, contadores de eventos no documento e de POSTs. */
async function admin(browser: Browser, viewport: { width: number; height: number }) {
  const ana = await personIn(browser, "Ana Sócia");
  await createOfficeVia(ana.page, "Escritório Layout");
  const page = ana.page;
  await page.setViewportSize(viewport);
  await page.addInitScript(() => {
    const w = window as unknown as { __invite: { submit: number; buttonClick: number } };
    w.__invite = { submit: 0, buttonClick: 0 };
    document.addEventListener("submit", () => { w.__invite.submit++; }, true);
    document.addEventListener("click", (e) => {
      const b = (e.target as Element | null)?.closest?.("button");
      if (b?.textContent?.includes("Gerar link de convite")) w.__invite.buttonClick++;
    }, true);
  });
  let posts = 0;
  page.on("request", (r) => {
    if (r.method() === "POST" && INVITE_PATH.test(new URL(r.url()).pathname)) posts++;
  });
  return { ...ana, page, posts: () => posts };
}

const counters = (page: Page) =>
  page.evaluate(() => (window as unknown as { __invite: Counters }).__invite);

/** Retém a PRIMEIRA leitura que casar com `pattern` até `release()`; as seguintes passam direto. */
async function hold(page: Page, pattern: RegExp, outcome: "deliver" | "network-error" = "deliver") {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  let reached!: () => void;
  const arrived = new Promise<void>((r) => { reached = r; });
  let first = true;
  await page.route(pattern, async (route: Route) => {
    if (!first || route.request().method() !== "GET") return route.continue();
    first = false;
    if (outcome === "deliver") {
      const resp = await route.fetch();                       // o servidor real já respondeu…
      reached();
      await gate;                                             // …e a resposta só chega quando liberada
      await route.fulfill({ response: resp }).catch(() => {});
    } else {
      reached();
      await gate;
      await route.abort("failed").catch(() => {});            // falha de rede SIMULADA
    }
  });
  return { arrived, release };
}

async function centerOf(page: Page) {
  const btn = page.getByRole("button", INVITE);
  await btn.scrollIntoViewIfNeeded();
  const box = (await btn.boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2, top: box.y };
}

/** O ponto (x, y) da tela pertence ao botão de convite habilitado (alvo utilizável). */
const targetAt = (page: Page, x: number, y: number) => page.evaluate(([px, py]) => {
  const b = document.elementFromPoint(px, py)?.closest("button");
  return !!b && !b.disabled && !!b.textContent?.includes("Gerar link de convite");
}, [x, y] as const);

const joinCodeCard = (page: Page) =>
  page.locator("section.card").filter({ has: page.getByRole("heading", { name: "Código de ingresso" }) });

/** Termina o fluxo: link exibido, lista recarregada com o convite e exatamente UM POST. */
async function expectSingleInvite(page: Page, posts: () => number) {
  await expect(page.getByLabel(LINK_LABEL)).toBeVisible();
  await expect(page.getByRole("list", { name: "Convites emitidos" }).getByText("Válido")).toHaveCount(1);
  expect(posts(), "POSTs de convite").toBe(1);
  expect(await counters(page), "eventos no documento").toEqual({ submit: 1, buttonClick: 1 });
}

for (const [label, viewport] of [["desktop", DESKTOP], ["tela estreita", NARROW]] as const) {
  test(`convite (${label}): código chega entre mousedown e mouseup no mesmo ponto → um POST e o link`, async ({ browser }) => {
    const a = await admin(browser, viewport);
    const page = a.page;
    const code = await hold(page, JOIN_CODE);
    await page.goto("/app/escritorio");
    await code.arrived;
    await expect(page.getByText("Nenhum convite emitido.")).toBeVisible();          // demais leituras prontas
    await expect(joinCodeCard(page).getByText("Carregando…")).toBeVisible();          // indicação de carregamento

    const p = await centerOf(page);
    expect(await targetAt(page, p.x, p.y), "alvo sob o cursor antes").toBe(true);
    await page.mouse.move(p.x, p.y);
    await page.mouse.down();
    code.release();
    await expect(page.getByTestId("join-code")).toBeVisible();                        // o cartão acima terminou
    const after = (await page.getByRole("button", INVITE).boundingBox())!;
    expect(after.y, "o botão não pode se deslocar durante o clique").toBe(p.top);
    expect(await targetAt(page, p.x, p.y), "alvo sob o cursor depois").toBe(true);
    await page.mouse.up();

    await expectSingleInvite(page, a.posts);
    await a.context.close();
  });
}

test("convite: carregamento lento do código e da lista — o botão funciona durante a espera", async ({ browser }) => {
  const a = await admin(browser, DESKTOP);
  const page = a.page;
  const code = await hold(page, JOIN_CODE);
  const list = await hold(page, /\/bff\/api\/offices\/[^/]+\/invitations$/);
  await page.goto("/app/escritorio");
  await Promise.all([code.arrived, list.arrived]);
  const p = await centerOf(page);
  await expect(joinCodeCard(page).getByText("Carregando…")).toBeVisible();
  await page.getByRole("button", INVITE).click();
  await expect(page.getByLabel(LINK_LABEL)).toBeVisible();                            // gerado ainda carregando
  await expect(joinCodeCard(page).getByText("Carregando…")).toBeVisible();
  code.release();
  list.release();
  await expect(page.getByTestId("join-code")).toBeVisible();
  expect((await page.getByRole("button", INVITE).boundingBox())!.y).toBe(p.top);
  await expectSingleInvite(page, a.posts);
  await a.context.close();
});

test("convite: erro na leitura do código não desloca o botão; o clique gera o link e a nova tentativa funciona", async ({ browser }) => {
  const a = await admin(browser, DESKTOP);
  const page = a.page;
  const code = await hold(page, JOIN_CODE, "network-error");
  await page.goto("/app/escritorio");
  await code.arrived;
  await expect(page.getByText("Nenhum convite emitido.")).toBeVisible();
  const p = await centerOf(page);
  await page.mouse.move(p.x, p.y);
  await page.mouse.down();
  code.release();
  const card = joinCodeCard(page);
  await expect(card.getByRole("alert")).toBeVisible();                                 // erro com nova tentativa
  expect((await page.getByRole("button", INVITE).boundingBox())!.y, "erro não pode deslocar o botão").toBe(p.top);
  await page.mouse.up();
  await expectSingleInvite(page, a.posts);

  await page.unroute(JOIN_CODE);
  await card.getByRole("button", { name: "Tentar novamente" }).click();
  await expect(page.getByTestId("join-code")).toBeVisible();
  expect((await page.getByRole("button", INVITE).boundingBox())!.y).toBe(p.top);
  await a.context.close();
});

test("convite: geração por teclado (Tab + Enter) com o código ainda carregando", async ({ browser }) => {
  const a = await admin(browser, NARROW);
  const page = a.page;
  const code = await hold(page, JOIN_CODE);
  await page.goto("/app/escritorio");
  await code.arrived;
  await page.getByLabel("Cargo exibido para o convidado").focus();
  await page.keyboard.press("Tab");
  const btn = page.getByRole("button", INVITE);
  await expect(btn).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByLabel(LINK_LABEL)).toBeVisible();
  code.release();
  await expect(page.getByTestId("join-code")).toBeVisible();
  await expectSingleInvite(page, a.posts);                                            // Enter = um clique, um envio
  await a.context.close();
});

test("convite: fluxo normal (sem retenção) e foco/navegação preservados na reserva", async ({ browser }) => {
  const a = await admin(browser, DESKTOP);
  const page = a.page;
  await page.goto("/app/escritorio");
  await expect(page.getByTestId("join-code")).toBeVisible();
  await expect(page.getByTestId("join-code")).toHaveCount(1);                          // a reserva sumiu
  await expect(page.getByRole("button", { name: "Gerar novo código" })).toHaveCount(1);
  await page.getByRole("button", INVITE).click();
  await expectSingleInvite(page, a.posts);
  await a.context.close();
});
