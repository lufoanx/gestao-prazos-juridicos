// Identidade de rede dos testes E2E (harness).
// Cada BrowserContext = um cliente de teste com IP ESTÁVEL e DISTINTO, atribuído de forma
// determinística (ordem de criação) em faixas reservadas para documentação (RFC 5737):
// 203.0.113.1–254 e depois 198.51.100.1–254. Abas do mesmo contexto compartilham o IP; trocar de
// usuário no mesmo contexto NÃO troca o IP (o limite é por IP, não por conta).
// O IP vai num cookie HttpOnly lido apenas pelo proxy de borda do E2E (e2e/edge-proxy.mjs), que o
// remove e define o cabeçalho confiável. O código da aplicação nunca escolhe o IP.
import { test as base, expect, type BrowserContext } from "@playwright/test";

const IDENTITY_COOKIE = "e2e_client_ip";
let sequence = 0;
const assigned = new WeakMap<BrowserContext, string>();

export function nextTestIp(): string {
  sequence += 1;
  if (sequence <= 254) return `203.0.113.${sequence}`;
  if (sequence <= 508) return `198.51.100.${sequence - 254}`;
  throw new Error("faixas de IP de teste esgotadas");
}

export async function assignNetworkIdentity(context: BrowserContext, ip = nextTestIp()): Promise<string> {
  const origin = `http://localhost:${Number(process.env.PRAZOAI_E2E_PORT || 3100)}`;
  await context.addCookies([{ name: IDENTITY_COOKIE, value: ip, url: origin, httpOnly: true, sameSite: "Strict" }]);
  assigned.set(context, ip);
  return ip;
}

export function networkIdentityOf(context: BrowserContext): string | undefined {
  return assigned.get(context);
}

export const test = base.extend<object, { networkIdentity: void }>({
  // Todo contexto criado pelos testes (inclusive via browser.newContext) recebe identidade própria.
  networkIdentity: [async ({ browser }, use) => {
    const original = browser.newContext.bind(browser);
    browser.newContext = async (options) => {
      const ctx = await original(options);
      await assignNetworkIdentity(ctx);
      return ctx;
    };
    await use();
    browser.newContext = original;
  }, { scope: "worker", auto: true }],
  context: async ({ browser }, use) => {
    const ctx = await browser.newContext();
    await use(ctx);
    await ctx.close();
  },
});

export { expect };
