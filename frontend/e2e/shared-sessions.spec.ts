// Doc 27 — sessões do BFF no armazenamento COMPARTILHADO (PostgreSQL), no navegador real.
// Roda quando PRAZOAI_E2E_BFF_DATABASE_URL está definida (CI); caso contrário é PULADO.
import pg from "pg";
import { expect, test } from "./fixtures";
import { logout, newEmail, signup } from "./helpers";

const DB = process.env.PRAZOAI_E2E_BFF_DATABASE_URL;

async function rows(sql: string, params: unknown[] = []): Promise<Array<Record<string, unknown>>> {
  const c = new pg.Client({ connectionString: DB });
  await c.connect();
  try { return (await c.query(sql, params)).rows; } finally { await c.end(); }
}

test.describe.configure({ mode: "serial" });

test("sessão do navegador fica no PostgreSQL cifrada; logout a remove", async ({ page, context }) => {
  test.skip(!DB, "PRAZOAI_E2E_BFF_DATABASE_URL não definida");
  const health = await (await page.request.get("/bff/health")).json();
  expect(health).toEqual({ status: "ok", sessionStore: "postgres" });
  const email = newEmail();
  await signup(page, "Clara Compartilhada", email);
  const sid = (await context.cookies()).find((c) => /_sid_/.test(c.name));
  expect(sid?.httpOnly).toBe(true);
  const all = await rows("SELECT id_hash, access_token_enc, refresh_token_enc FROM prazoai_bff.sessions");
  expect(all.length).toBeGreaterThan(0);
  // o valor do cookie nunca é gravado; só o hash
  const raw = JSON.stringify(all.map((r) => Object.values(r).map((v) => (Buffer.isBuffer(v) ? v.toString("latin1") : String(v)))));
  expect(raw.includes(sid!.value)).toBe(false);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Olá, Clara Compartilhada" })).toBeVisible();
  // Conta só as sessões DESTE usuário: a tabela é compartilhada com os outros testes (sessões criadas,
  // renovadas ou expiradas ao mesmo tempo não podem mudar o resultado).
  const userId = await page.evaluate(async () =>
    String((await (await fetch("/bff/session", { headers: { "x-prazoai-csrf": "1" } })).json()).user.id));
  const mine = () => rows("SELECT 1 FROM prazoai_bff.sessions WHERE user_id = $1", [userId]);
  expect((await mine()).length).toBe(1);
  await logout(page);
  expect((await mine()).length).toBe(0);
});
