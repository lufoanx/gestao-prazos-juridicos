// Identidade de rede do E2E e limites de convite (sem alterar ORG_INVITE_*_MAX):
// mesmo IP atinge 429; outro IP segue; abas do mesmo contexto compartilham o contador; trocar de
// usuário no mesmo contexto não troca o IP; cabeçalhos forjados pela página não escapam do limite.
import { type Page } from "@playwright/test";
import { expect, networkIdentityOf, test } from "./fixtures";
import { logout, newEmail, signupToOnboarding } from "./helpers";

const SECRET = process.env.PRAZOAI_E2E_PROXY_SECRET ?? "";
const token = (n: number) => `tok${String(n).padStart(4, "0")}${"x".repeat(30)}`;

async function lookup(page: Page, t: string, extra: Record<string, string> = {}) {
  return page.evaluate(async ({ t, extra }) => (await fetch("/bff/public/invitations/lookup", {
    method: "POST", headers: { "x-prazoai-csrf": "1", "content-type": "application/json", ...extra }, body: JSON.stringify({ token: t }),
  })).status, { t, extra });
}
async function accept(page: Page, t: string) {
  return page.evaluate(async (t) => (await fetch("/bff/api/invitations/accept", {
    method: "POST", headers: { "x-prazoai-csrf": "1", "content-type": "application/json" }, body: JSON.stringify({ token: t }),
  })).status, t);
}

test("consulta de convite: mesmo IP (duas abas) chega ao 429; cabeçalhos forjados não escapam; outro IP segue", async ({ browser }) => {
  const a = await browser.newContext();
  const ipA = networkIdentityOf(a)!;
  const tab1 = await a.newPage();
  const tab2 = await a.newPage();
  const seenHeaders: string[] = [];
  for (const p of [tab1, tab2]) p.on("request", (r) => seenHeaders.push(JSON.stringify(r.headers()) + r.url()));
  await tab1.goto("/login");
  await tab2.goto("/login");
  for (let i = 0; i < 30; i++) expect(await lookup(i % 2 ? tab2 : tab1, token(i))).toBe(200);   // ORG_INVITE_LOOKUP_MAX=30
  expect(await lookup(tab2, token(100))).toBe(429);                                              // contador compartilhado
  expect(await lookup(tab1, token(101))).toBe(429);
  expect(await lookup(tab1, token(102), { "x-forwarded-for": "203.0.113.250", "x-prazoai-e2e-client-ip": "203.0.113.251", "x-real-ip": "203.0.113.252" })).toBe(429);

  const b = await browser.newContext();
  const ipB = networkIdentityOf(b)!;
  expect(ipB).not.toBe(ipA);
  expect(ipA).toMatch(/^(203\.0\.113|198\.51\.100)\.\d+$/);
  const other = await b.newPage();
  await other.goto("/login");
  expect(await lookup(other, token(200))).toBe(200);                                             // outro cliente, outro limite

  expect(SECRET.length).toBeGreaterThanOrEqual(64);
  expect(seenHeaders.some((h) => h.includes(SECRET))).toBe(false);                              // segredo nunca no navegador
  expect(await tab1.content()).not.toContain(SECRET);
  expect(await tab1.evaluate(() => document.cookie)).not.toContain("e2e_client_ip");          // identidade HttpOnly
  await a.close();
  await b.close();
});

test("aceite de convite: limite por IP atravessa a troca de usuário no mesmo contexto; outro IP segue", async ({ browser }) => {
  const a = await browser.newContext();
  const page = await a.newPage();
  await signupToOnboarding(page, "Usuária Um", newEmail());
  for (let i = 0; i < 6; i++) expect(await accept(page, token(300 + i))).toBe(404);              // convite inexistente
  await page.goto("/app");
  await logout(page);
  await signupToOnboarding(page, "Usuária Dois", newEmail());                                     // mesma rede, outra conta
  for (let i = 0; i < 4; i++) expect(await accept(page, token(310 + i))).toBe(404);              // 10 no IP (ORG_INVITE_ACCEPT_MAX=10)
  expect(await accept(page, token(320))).toBe(429);                                               // conta nova, mesmo IP → limite
  const b = await browser.newContext();
  const pageB = await b.newPage();
  await signupToOnboarding(pageB, "Usuária Três", newEmail());
  expect(await accept(pageB, token(330))).toBe(404);                                              // outro IP: segue (não é 429)
  await a.close();
  await b.close();
});
