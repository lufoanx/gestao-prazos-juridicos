// Deve rodar POR ÚLTIMO (ordem alfabética dos arquivos): derruba o backend do E2E.
import { expect, test } from "@playwright/test";
import { newEmail, signup } from "./helpers";

const DEMO_TEXTS = ["Contestação — locação residencial", "Paula Andrade", "Rafael Neves"];

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
