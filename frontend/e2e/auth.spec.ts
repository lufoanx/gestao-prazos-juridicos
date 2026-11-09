// E2E 6.1 — navegador real + Next (build integrado) + FastAPI real.
import { expect, test } from "@playwright/test";
import { captureBffBodies, login, logout, newEmail, signup } from "./helpers";

const DEMO_TEXTS = ["Contestação — locação residencial", "Paula Andrade", "Rafael Neves"];
const TOKEN_LIKE = /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/; // JWT

test.describe.configure({ mode: "serial" });

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
  expect(visible.cookie).not.toContain("prazoai_sid");                 // HttpOnly
  expect(visible.local).not.toMatch(TOKEN_LIKE);
  expect(visible.session).not.toMatch(TOKEN_LIKE);
  expect(visible.local).not.toContain("prazoai:demo");                // modo integrado não usa chaves demo
  for (const b of bodies) expect(b).not.toMatch(TOKEN_LIKE);
  expect(bodies.join("")).not.toMatch(/accessToken|refreshToken/);
  const cookies = await context.cookies();
  const sid = cookies.find((c) => c.name === "prazoai_sid");
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
  for (const path of ["/app/prazos", "/app/dashboard", "/app/intimacoes"]) {
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

// Deve ser o ÚLTIMO: derruba o backend.
test("backend indisponível: estado de indisponibilidade, sem logout indevido nem dados demonstrativos", async ({ page }) => {
  await signup(page, "Iris Final", newEmail());
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const pid = Number(readFileSync(join(__dirname, ".backend.pid"), "utf8"));
  process.kill(pid, "SIGTERM");
  await page.waitForTimeout(800);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Serviço indisponível" })).toBeVisible();
  await expect(page).not.toHaveURL(/\/login$/);
  for (const t of DEMO_TEXTS) await expect(page.getByText(t)).toHaveCount(0);
});
