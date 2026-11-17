// Harness da E5 (recuperação de senha no navegador). Nada aqui é código da aplicação.
// - O capturador (Mailpit) é lido SÓ pelo harness, pela API em loopback (tests/helpers/mailpit.mjs).
// - Falhas nunca exibem token, senha, corpo de e-mail ou URL com fragmento: as verificações usam
//   `check`/`checkAbsent` (só o nome do requisito) e a navegação com token passa por `openLink`.
import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { expect, type BrowserContext, type Page, type Request } from "@playwright/test";

// Módulos ESM compartilhados com os testes unitários/integração (cliente do capturador, verificações
// sanitizadas e os TEXTOS da própria tela). Os specs do Playwright são CommonJS: carregados por
// import() dinâmico em `loadKit()` (chamado no beforeAll do spec).
type Captured = { readonly text: string };
interface Mailpit {
  messagesTo(address: string): Promise<Captured[]>;
  deleteAll(): Promise<void>;
}
interface Kit {
  mail: Mailpit | null;
  tokenFrom(message: Captured, origin: string): string;
  check(condition: unknown, requirement: string): void;
  checkAbsent(text: string, secrets: Record<string, string>, where: string): void;
  text: Readonly<Record<string, string>>;
}
let cached: Kit | null = null;
export async function loadKit(): Promise<Kit> {
  if (!cached) {
    const [mp, sensitive, flow] = await Promise.all([
      import("../tests/helpers/mailpit.mjs"), import("../tests/helpers/sensitive.mjs"), import("../src/lib/integration/recovery-flow.mjs"),
    ]);
    cached = { mail: mp.mailpitFromEnv(), tokenFrom: mp.tokenFrom, check: sensitive.check, checkAbsent: sensitive.checkAbsent, text: flow.RECOVERY_TEXT };
  }
  return cached;
}
const kit = (): Kit => { if (!cached) throw new Error("loadKit() não foi chamado"); return cached; };
export const check = (condition: unknown, requirement: string) => kit().check(condition, requirement);
export const checkAbsent = (text: string, secrets: Record<string, string>, where: string) => kit().checkAbsent(text, secrets, where);
/** Textos da tela (os mesmos do código da aplicação). */
export const T = () => kit().text;
export const MAIL = () => kit().mail;
export const ORIGIN = `http://localhost:${Number(process.env.PRAZOAI_E2E_PORT || 3100)}`;
export const PUBLIC = "/bff/public/password/";
/** Senhas fictícias geradas por execução (nunca impressas). */
export const freshPassword = () => `Nova-${randomBytes(6).toString("hex")}-Aa1`;
/** Token com a forma de um token real, mas que o backend nunca emitiu. */
export const fakeToken = () => randomBytes(32).toString("base64url");

/** Tudo o que sai do navegador neste contexto: URL e cabeçalhos de cada requisição. */
export function recordRequests(context: BrowserContext) {
  const all: Request[] = [];
  context.on("request", (r) => all.push(r));
  return {
    all,
    to: (path: string, method?: string) => all.filter((r) => new URL(r.url()).pathname === path && (!method || r.method() === method)),
  };
}

/** Abre o link recebido (com fragmento) sem que uma falha de navegação imprima a URL. */
export async function openLink(page: Page, token: string) {
  let failed = false;
  try { await page.goto(`/redefinir-senha#${token}`); } catch { failed = true; }
  check(!failed, "abrir o link de redefinição");
}

/** Espera a CONDIÇÃO observável "n mensagens para o endereço" (prazo só de proteção). */
export async function tokensFor(email: string, n: number): Promise<string[]> {
  const mail = MAIL();
  check(mail !== null, "capturador configurado");
  const end = Date.now() + 20_000;
  for (;;) {
    const msgs = await mail!.messagesTo(email);
    if (msgs.length >= n) { check(msgs.length === n, "quantidade de mensagens"); return msgs.map((m) => kit().tokenFrom(m, ORIGIN)); }
    check(Date.now() < end, "mensagem esperada chegou ao capturador");
    await new Promise((r) => setTimeout(r, 100));
  }
}

export async function messageCount(email: string) {
  return (await MAIL()!.messagesTo(email)).length;
}

/** Pedido pela interface (a partir de /esqueci-senha já aberto ou abrindo-o). */
export async function requestLinkVia(page: Page, email: string, { open = true } = {}) {
  if (open) await page.goto("/esqueci-senha");
  await page.getByLabel("E-mail").fill(email);
  await page.getByRole("button", { name: "Enviar link" }).click();
  await expect(page.getByText(T().accepted)).toBeVisible();
}

export async function fillNewPassword(page: Page, password: string, confirm = password) {
  await page.getByRole("textbox", { name: "Nova senha", exact: true }).fill(password);
  await page.getByRole("textbox", { name: "Confirmar nova senha", exact: true }).fill(confirm);
}

/** Tentativa de login: "ok" (painel) ou "invalid" (credenciais recusadas). */
export async function loginOutcome(page: Page, email: string, password: string): Promise<"ok" | "invalid"> {
  await page.goto("/login");
  await page.getByLabel("E-mail").fill(email);
  await page.locator('input[autocomplete="current-password"]').fill(password);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  const invalid = page.getByText("E-mail ou senha inválidos.");
  const panel = page.getByRole("heading", { name: /^Olá, / });
  await expect(invalid.or(panel)).toBeVisible();
  return (await panel.isVisible()) ? "ok" : "invalid";
}

/**
 * O token não aparece em: URL atual (nem no fragmento), DOM, localStorage, sessionStorage,
 * document.cookie, cookies do contexto, caminho/query/cabeçalhos de QUALQUER requisição. No corpo,
 * só nos POST de redefinição ao BFF.
 */
export async function expectTokenNowhere(page: Page, context: BrowserContext, token: string, requests: Request[]) {
  const where = await page.evaluate(() => ({
    href: location.href, dom: document.documentElement.outerHTML, cookie: document.cookie,
    local: JSON.stringify({ ...localStorage }), session: JSON.stringify({ ...sessionStorage }),
  }));
  checkAbsent(where.href, { token }, "URL atual");
  check(!where.href.includes("#"), "fragmento removido da barra");
  checkAbsent(where.dom, { token }, "DOM");
  checkAbsent(where.cookie + where.local + where.session, { token }, "storage/cookie do documento");
  checkAbsent(JSON.stringify(await context.cookies()), { token }, "cookies do contexto");
  for (const r of requests) {
    const u = new URL(r.url());
    checkAbsent(u.pathname + u.search, { token }, "URL de requisição");
    // cabeçalhos enviados pela página (Referer, cabeçalhos do roteador do Next…); cookies já conferidos acima
    checkAbsent(JSON.stringify(r.headers()), { token }, "cabeçalhos de requisição");
    const body = r.postData() ?? "";
    if (body.includes(token)) check(r.method() === "POST" && u.pathname === `${PUBLIC}reset`, "token só no corpo do POST de redefinição");
  }
}

/** Respostas das rotas públicas não tocam em cookies. */
export async function expectNoSetCookie(requests: Request[]) {
  for (const r of requests.filter((x) => new URL(x.url()).pathname.startsWith(PUBLIC))) {
    const res = await r.response();
    if (res) check(!(await res.allHeaders())["set-cookie"], "rota pública sem Set-Cookie");
  }
}

/**
 * Fixture de EXPIRAÇÃO no banco descartável do E2E (harness, não a aplicação): antecipa
 * `expires_at` do token ativo identificado pelo HASH (o token não sai deste processo). Só PostgreSQL.
 */
export function expireTokenInDatabase(token: string) {
  const url = process.env.DATABASE_URL ?? "";
  check(process.env.STORAGE === "postgres" && url.startsWith("postgresql"), "banco descartável do E2E");
  const script = [
    "import os, psycopg",
    "url = os.environ['DATABASE_URL'].replace('postgresql+psycopg://', 'postgresql://', 1)",
    "with psycopg.connect(url) as c:",
    "    n = c.execute(\"UPDATE prazoai.password_reset_tokens SET expires_at = now() - interval '1 hour' \"",
    "                  \"WHERE token_hash = %s AND used_at IS NULL AND invalidated_at IS NULL\", (os.environ['E2E_TOKEN_HASH'],)).rowcount",
    "print(n)",
  ].join("\n");
  const out = spawnSync(process.env.PRAZOAI_TEST_PYTHON || "python3", ["-c", script], {
    cwd: join(__dirname, "..", "..", "backend"),
    env: { PATH: process.env.PATH ?? "", LD_LIBRARY_PATH: process.env.LD_LIBRARY_PATH ?? "", DATABASE_URL: url,
      E2E_TOKEN_HASH: createHash("sha256").update(token, "utf8").digest("hex") } as unknown as NodeJS.ProcessEnv,
    encoding: "utf8", timeout: 30_000,
  });
  check(out.status === 0 && out.stdout.trim() === "1", "fixture de expiração aplicada a exatamente um token");
}
