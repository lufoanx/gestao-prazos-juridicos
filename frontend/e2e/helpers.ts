import { expect, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";

export const PASSWORD = "Senha-de-teste-123";
export const newEmail = () => `e2e${randomBytes(4).toString("hex")}@exemplo.com`;

export async function signup(page: Page, name: string, email: string) {
  await page.goto("/cadastro");
  await page.getByLabel("Nome").fill(name);
  await page.getByLabel("E-mail").fill(email);
  const pw = page.locator('input[autocomplete="new-password"]');
  await pw.nth(0).fill(PASSWORD);
  await pw.nth(1).fill(PASSWORD);
  await page.getByRole("button", { name: "Criar conta", exact: true }).click();
  await expect(page).toHaveURL(/\/app$/);
  await expect(page.getByRole("heading", { name: `Olá, ${name}` })).toBeVisible();
}

export async function login(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("E-mail").fill(email);
  await page.locator('input[autocomplete="current-password"]').fill(PASSWORD);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await expect(page).toHaveURL(/\/app$/);
}

export async function logout(page: Page) {
  await page.getByRole("button", { name: "Sair" }).click();
  await expect(page).toHaveURL(/\/login$/);
}

/** Tudo que o navegador consegue ver: storages, cookies acessíveis ao JS e corpos das respostas do BFF. */
export function captureBffBodies(page: Page): string[] {
  const bodies: string[] = [];
  page.on("response", async (r) => {
    if (r.url().includes("/bff/")) { try { bodies.push(await r.text()); } catch { /* sem corpo */ } }
  });
  return bodies;
}
