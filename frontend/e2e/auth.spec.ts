// E2E 6.1 — navegador real + Next (build integrado) + FastAPI real.
import { expect, test } from "./fixtures";
import { PASSWORD, captureBffBodies, login, logout, newEmail, signup } from "./helpers";

const DEMO_TEXTS = ["Contestação — locação residencial", "Paula Andrade", "Rafael Neves"];
const TOKEN_LIKE = /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/; // JWT

test.describe.configure({ mode: "serial" });

// Controle do proxy de TESTE entre o BFF e o FastAPI (segura uma chamada para reproduzir corridas).
const CONTROL = `http://127.0.0.1:${Number(process.env.PRAZOAI_E2E_BACKEND_PORT || 18900) + 1}/__e2e`;
const held = async () => (await (await fetch(`${CONTROL}/status`)).json()).held;


test("cadastro, sessão após recarregar, perfil e logout", async ({ page }) => {
  const email = newEmail();
  await signup(page, "Ana Integrada", email);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Olá, Ana Integrada" })).toBeVisible();
  await page.goto("/app/perfil");
  await expect(page.getByLabel("E-mail")).toHaveValue(email);
  await page.getByLabel("Nome").fill("Ana Renomeada");
  await page.getByRole("button", { name: "Salvar" }).click();
  await expect(page.getByText("Perfil atualizado.")).toBeVisible();
  await page.reload();
  await expect(page.getByLabel("Nome")).toHaveValue("Ana Renomeada");
  await logout(page);
  await page.goto("/app");
  await expect(page).toHaveURL(/\/login$/);
});

test("nenhum token em JSON, storage ou cookies acessíveis ao JavaScript", async ({ page, context }) => {
  const bodies = captureBffBodies(page);
  const email = newEmail();
  await signup(page, "Bia Segura", email);
  await page.reload();
  await page.goto("/app/perfil");
  await expect(page.getByLabel("E-mail")).toHaveValue(email);
  const visible = await page.evaluate(() => ({
    cookie: document.cookie,
    local: JSON.stringify({ ...localStorage }),
    session: JSON.stringify({ ...sessionStorage }),
  }));
  expect(visible.cookie).not.toContain("prazoai_");                    // HttpOnly (sessão e navegador)
  expect(visible.local).not.toMatch(TOKEN_LIKE);
  expect(visible.session).not.toMatch(TOKEN_LIKE);
  expect(visible.local).not.toContain("prazoai:demo");                // modo integrado não usa chaves demo
  for (const b of bodies) expect(b).not.toMatch(TOKEN_LIKE);
  expect(bodies.join("")).not.toMatch(/accessToken|refreshToken/);
  const cookies = await context.cookies();
  const sid = cookies.find((c) => /^prazoai_sid_[a-z0-9]{10}$/.test(c.name));
  expect(sid?.httpOnly).toBe(true);
  expect(sid?.sameSite).toBe("Strict");
  expect(sid?.value).toMatch(/^[A-Za-z0-9_-]{43}$/);                  // identificador opaco
  await logout(page);
});

test("duas abas renovando ao mesmo tempo mantêm a sessão (rotação serializada no BFF)", async ({ context }) => {
  const a = await context.newPage();
  const email = newEmail();
  await signup(a, "Caio Abas", email);
  const b = await context.newPage();
  await b.goto("/app/perfil");
  await expect(b.getByLabel("E-mail")).toHaveValue(email);
  for (let round = 0; round < 3; round++) {
    await a.waitForTimeout(1500);                                       // access "perto de expirar" (margem 59 s)
    await Promise.all([a.reload(), b.reload()]);
    await expect(a.getByRole("heading", { name: "Olá, Caio Abas" })).toBeVisible();
    await expect(b.getByLabel("E-mail")).toHaveValue(email);
  }
  // Rodada final: a sessão segue válida (sem detecção de reutilização no backend).
  await b.goto("/app");
  await expect(b.getByRole("heading", { name: "Olá, Caio Abas" })).toBeVisible();
  await a.close();
  await b.close();
});

test("logout em uma aba leva a outra ao login (aviso entre abas, sem dados residuais)", async ({ context }) => {
  const a = await context.newPage();
  await signup(a, "Dani Duas", newEmail());
  const b = await context.newPage();
  await b.goto("/app");
  await expect(b.getByRole("heading", { name: "Olá, Dani Duas" })).toBeVisible();
  await logout(a);
  await expect(b).toHaveURL(/\/login$/);
  await b.goto("/app");
  await expect(b).toHaveURL(/\/login$/);
  await a.close();
  await b.close();
});

test("troca de usuário não vaza dados do anterior", async ({ page }) => {
  const first = newEmail();
  const second = newEmail();
  await signup(page, "Eva Primeira", first);
  await logout(page);
  await signup(page, "Fábio Segundo", second);
  await page.goto("/app/perfil");
  await expect(page.getByLabel("E-mail")).toHaveValue(second);
  await expect(page.getByText("Eva Primeira")).toHaveCount(0);
  await logout(page);
  await login(page, first);
  await page.goto("/app/perfil");
  await expect(page.getByLabel("E-mail")).toHaveValue(first);
  await logout(page);
});

test("módulos não integrados não exibem dados demonstrativos; recursos inexistentes desabilitados", async ({ page }) => {
  await signup(page, "Gil Módulos", newEmail());
  // 6.3 integrou prazos/calendário; os módulos abaixo seguem não integrados.
  for (const path of ["/app/dashboard", "/app/intimacoes", "/app/notificacoes"]) {
    await page.goto(path);
    await expect(page.getByRole("heading", { name: "Módulo ainda não integrado" })).toBeVisible();
    for (const t of DEMO_TEXTS) await expect(page.getByText(t)).toHaveCount(0);
  }
  await page.goto("/esqueci-senha");
  await expect(page.getByRole("heading", { name: "Indisponível nesta fase" })).toBeVisible();
  await page.goto("/app");
  await logout(page);
  await page.goto("/login");
  await expect(page.getByRole("button", { name: /Entrar com Google — indisponível/ })).toBeDisabled();
});

test("credenciais inválidas e validações de senha", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("E-mail").fill(newEmail());
  await page.locator('input[autocomplete="current-password"]').fill("errada-123");
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await expect(page.getByText("E-mail ou senha inválidos.")).toBeVisible();
  await page.goto("/cadastro");
  await page.getByLabel("Nome").fill("Hugo");
  await page.getByLabel("E-mail").fill(newEmail());
  await page.locator('input[autocomplete="new-password"]').nth(0).fill("curta");
  await page.locator('input[autocomplete="new-password"]').nth(1).fill("curta");
  await page.getByRole("button", { name: "Criar conta", exact: true }).click();
  await expect(page.getByText("A senha deve ter pelo menos 8 caracteres.")).toBeVisible();
});

test("login pausado numa aba + logout na outra: a resposta tardia não instala sessão", async ({ context }) => {
  const a = await context.newPage();
  const email = newEmail();
  await signup(a, "Jade Abas", email);
  const b = await context.newPage();
  await b.goto("/app");
  await expect(b.getByRole("heading", { name: "Olá, Jade Abas" })).toBeVisible();
  await fetch(`${CONTROL}/hold?path=/api/v1/auth/login`, { method: "POST" });
  await a.goto("/login");
  await a.getByLabel("E-mail").fill(email);
  await a.locator('input[autocomplete="current-password"]').fill(PASSWORD);
  await a.getByRole("button", { name: "Entrar", exact: true }).click();            // login fica pendente
  await expect.poll(async () => (await (await fetch(`${CONTROL}/status`)).json()).held).toBe(1);
  await logout(b);                                                                   // logout na outra aba
  await fetch(`${CONTROL}/release`, { method: "POST" });
  await expect(a.getByText("O login foi cancelado porque a sessão foi encerrada em outra aba")).toBeVisible();
  await a.goto("/app");
  await expect(a).toHaveURL(/\/login$/);                                            // nenhuma sessão instalada
  expect((await context.cookies()).some((c) => c.name.startsWith("prazoai_sid_"))).toBe(false);
  await login(a, email);                                                             // login explícito depois funciona
  await expect(a.getByRole("heading", { name: "Olá, Jade Abas" })).toBeVisible();
  await logout(a);
  await a.close();
  await b.close();
});


test("resposta cancelada não apaga o cookie do login vencedor (duas abas reais)", async ({ context }) => {
  const a = await context.newPage();
  const email = newEmail();
  await signup(a, "Lia Vence", email);
  const b = await context.newPage();
  await b.goto("/login");
  await fetch(`${CONTROL}/hold?path=/api/v1/auth/login`, { method: "POST" });       // segura só o login A
  await a.goto("/login");
  await a.getByLabel("E-mail").fill(email);
  await a.locator('input[autocomplete="current-password"]').fill(PASSWORD);
  await a.getByRole("button", { name: "Entrar", exact: true }).click();               // login A pendente
  await expect.poll(held).toBe(1);
  await b.getByLabel("E-mail").fill(email);
  await b.locator('input[autocomplete="current-password"]').fill(PASSWORD);
  await b.getByRole("button", { name: "Entrar", exact: true }).click();               // login B conclui
  await expect(b).toHaveURL(/\/app$/);
  const winner = (await context.cookies()).filter((c) => c.name.startsWith("prazoai_sid_")).map((c) => `${c.name}=${c.value}`);
  expect(winner).toHaveLength(1);
  await fetch(`${CONTROL}/release`, { method: "POST" });                             // resposta tardia de A
  await expect(a.getByText("O login foi cancelado")).toBeVisible();
  const after = (await context.cookies()).filter((c) => c.name.startsWith("prazoai_sid_")).map((c) => `${c.name}=${c.value}`);
  expect(after).toEqual(winner);                                                     // cookie vencedor intacto
  await b.reload();
  await expect(b.getByRole("heading", { name: "Olá, Lia Vence" })).toBeVisible();   // continua autenticado
  await a.goto("/app");
  await expect(a.getByRole("heading", { name: "Olá, Lia Vence" })).toBeVisible();
  await logout(a);
  await a.close();
  await b.close();
});

test("logout durante a revogação feita pelo login não é revertido (duas abas reais)", async ({ context }) => {
  const a = await context.newPage();
  const email = newEmail();
  await signup(a, "Mel Revoga", email);
  const b = await context.newPage();
  await b.goto("/app");
  await expect(b.getByRole("heading", { name: "Olá, Mel Revoga" })).toBeVisible();
  await fetch(`${CONTROL}/hold?path=/api/v1/auth/logout`, { method: "POST" });      // revogação da sessão anterior
  await a.goto("/login");
  await a.getByLabel("E-mail").fill(email);
  await a.locator('input[autocomplete="current-password"]').fill(PASSWORD);
  await a.getByRole("button", { name: "Entrar", exact: true }).click();
  await expect.poll(held).toBe(1);                                                   // login já publicou e está revogando
  await logout(b);
  await fetch(`${CONTROL}/release`, { method: "POST" });
  await expect(a.getByText("O login foi cancelado")).toBeVisible();
  expect((await context.cookies()).some((c) => c.name.startsWith("prazoai_sid_"))).toBe(false);
  await a.goto("/app");
  await expect(a).toHaveURL(/\/login$/);
  await login(a, email);                                                             // login explícito depois funciona
  await logout(a);
  await a.close();
  await b.close();
});
