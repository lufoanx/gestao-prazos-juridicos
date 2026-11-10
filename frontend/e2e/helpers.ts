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
  // 6.2: depois do cadastro vem o onboarding; os testes de sessão seguem pelo ambiente pessoal.
  await expect(page).toHaveURL(/\/onboarding$/);
  await page.getByRole("button", { name: "Usar ambiente pessoal" }).click();
  await expect(page).toHaveURL(/\/app$/);
  await expect(page.getByRole("heading", { name: `Olá, ${name}` })).toBeVisible();
}

/** Cadastro que PARA no onboarding (fluxos da 6.2). */
export async function signupToOnboarding(page: Page, name: string, email: string) {
  await page.goto("/cadastro");
  await page.getByLabel("Nome").fill(name);
  await page.getByLabel("E-mail").fill(email);
  const pw = page.locator('input[autocomplete="new-password"]');
  await pw.nth(0).fill(PASSWORD);
  await pw.nth(1).fill(PASSWORD);
  await page.getByRole("button", { name: "Criar conta", exact: true }).click();
  await expect(page).toHaveURL(/\/onboarding$/);
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

// ---------------------------------------------------------------- 6.3: helpers compartilhados
import type { Browser } from "@playwright/test";

export const BACKEND = `http://127.0.0.1:${Number(process.env.PRAZOAI_E2E_BACKEND_PORT || 18900) + 1}`;

export async function personIn(browser: Browser, name: string, opts: { timezoneId?: string } = {}) {
  const context = await browser.newContext(opts);
  const page = await context.newPage();
  const email = newEmail();
  await signupToOnboarding(page, name, email);
  return { context, page, email, name };
}

export async function createOfficeVia(page: Page, officeName: string) {
  await page.getByLabel("Nome do escritório").fill(officeName);
  await page.getByRole("button", { name: "Criar escritório" }).click();
  await expect(page).toHaveURL(/\/app\/escritorio$/);
}

export async function joinByInvite(admin: Page, member: Page) {
  await admin.goto("/app/escritorio");
  await admin.getByRole("button", { name: "Gerar link de convite" }).click();
  const link = await admin.getByLabel("Link do convite (exibido só agora)").inputValue();
  await member.goto(link);
  await member.getByRole("button", { name: "Aceitar convite" }).click();
  await member.getByRole("button", { name: "Aceitar e entrar" }).click();
  await expect(member).toHaveURL(/\/app\/escritorio$/);
}

export async function idsOf(page: Page) {
  return page.evaluate(async () => {
    const h = { headers: { "x-prazoai-csrf": "1" } };
    const s = await (await fetch("/bff/session", h)).json();
    const m = await (await fetch("/bff/api/memberships/me", h)).json();
    return { uid: s.user.id as string, oid: (m.office?.id ?? null) as string | null };
  });
}

/** Alteração de permissões/visibilidade pela sessão do administrador (mesmo contrato da tela). */
export async function patchMember(adminPage: Page, oid: string, uid: string, body: Record<string, unknown>) {
  const status = await adminPage.evaluate(async ({ oid, uid, body }) => (await fetch(`/bff/api/offices/${oid}/members/${uid}`, {
    method: "PATCH", headers: { "x-prazoai-csrf": "1", "content-type": "application/json" }, body: JSON.stringify(body),
  })).status, { oid, uid, body });
  expect(status).toBe(200);
}

/** Fixture: chamadas DIRETAS à API existente do backend, com a conta de teste (não passam pelo BFF). */
export async function backendToken(email: string) {
  const r = await fetch(`${BACKEND}/api/v1/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password: PASSWORD }) });
  return (await r.json()).accessToken as string;
}
export async function seedDeadlines(email: string, n: number, over: Record<string, unknown> = {}) {
  const token = await backendToken(email);
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const r = await fetch(`${BACKEND}/api/v1/deadlines`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ scope: "personal", title: `Prazo semeado ${String(i).padStart(3, "0")}`, caseNumber: "0001234-56.2026", court: "TJSC",
        practiceArea: "Cível", startDate: "2026-11-01", dueDate: "2026-11-20", countingMode: "business", duration: 10, ...over }) });
    expect(r.status).toBe(201);
    ids.push((await r.json()).id);
  }
  return ids;
}
