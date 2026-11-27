// Entrar com Google de ponta a ponta: navegador real → BFF → provedor OIDC de TESTE (imita o Google)
// → BFF troca o código (PKCE + segredo) → FastAPI confere a assinatura do ID token pela JWKS → sessão.
import { expect, test, type Page } from "@playwright/test";
import { E2E } from "../playwright.config";
import { logout, newEmail, signup } from "./helpers";

async function nextGoogleAccount(q: Record<string, string>) {
  const r = await fetch(`${E2E.google}/__next?${new URLSearchParams(q)}`);
  expect(r.ok).toBe(true);
}

async function clickGoogle(page: Page, from: "/login" | "/cadastro") {
  await page.goto(from);
  await page.getByTestId("google-login").click();
}

test("conta nova pelo Google: entra direto no app e a sessão sobrevive ao recarregar", async ({ page, context }) => {
  const email = newEmail();
  await nextGoogleAccount({ email, name: "Iara Google" });
  await clickGoogle(page, "/cadastro");
  await expect(page).toHaveURL(/\/app$/);
  await expect(page.getByRole("heading", { name: "Olá, Iara Google" })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: "Olá, Iara Google" })).toBeVisible();
  // Nada do fluxo fica legível ao JavaScript: cookies de sessão e de state são HttpOnly.
  const cookies = await context.cookies();
  expect(cookies.filter((c) => c.name.includes("prazoai")).every((c) => c.httpOnly)).toBe(true);
  expect(cookies.some((c) => c.name.includes("gauth"))).toBe(false);     // state de uso único já apagado
  await logout(page);
  // Segunda vez: mesma conta (sem duplicar).
  await nextGoogleAccount({ email, name: "Iara Google" });
  await clickGoogle(page, "/login");
  await expect(page.getByRole("heading", { name: "Olá, Iara Google" })).toBeVisible();
});

test("e-mail já cadastrado com senha: o Google entra na MESMA conta", async ({ page }) => {
  const email = newEmail();
  await signup(page, "Jonas Senha", email);
  await logout(page);
  await nextGoogleAccount({ email, name: "Outro Nome no Google" });
  await clickGoogle(page, "/login");
  await expect(page).toHaveURL(/\/app$/);
  await expect(page.getByRole("heading", { name: "Olá, Jonas Senha" })).toBeVisible();
});

test("pessoa cancela no Google: volta ao login com aviso claro e sem sessão", async ({ page }) => {
  await nextGoogleAccount({ cancel: "1" });
  await clickGoogle(page, "/login");
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByTestId("google-error")).toBeVisible();
  await page.goto("/app");
  await expect(page).toHaveURL(/\/login/);
});
