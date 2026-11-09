// Proteções básicas do BFF: CSRF (Origin + cabeçalho próprio), cookies e cabeçalhos.

export const CSRF_HEADER = "x-prazoai-csrf";
const SAFE_METHODS = new Set(["GET", "HEAD"]);

/**
 * Todas as chamadas do cliente exigem o cabeçalho próprio; mutações (inclusive login e logout)
 * exigem também Origin igual à origem configurada. SameSite não é a única defesa.
 * @returns {null | { status: number, code: string, message: string }}
 */
export function checkCsrf(method, headers, config) {
  if (headers.get(CSRF_HEADER) !== "1") {
    return { status: 403, code: "csrf_rejected", message: "Requisição recusada." };
  }
  if (!SAFE_METHODS.has(method)) {
    const origin = headers.get("origin");
    if (!origin || origin !== config.appOrigin) {
      return { status: 403, code: "csrf_rejected", message: "Requisição recusada." };
    }
  }
  return null;
}

// ---------------------------------------------------------------- cookies de sessão
// Protocolo (auditoria 6.1, v3): cada sessão tem um cookie com NOME EXCLUSIVO
// (`<base>_<slot>`, slot aleatório de 10 caracteres). Assim, uma resposta só consegue apagar
// cookies que ela mesma observou (pelo nome) — nunca o cookie de uma tentativa mais nova, que
// sempre tem outro nome. Respostas atrasadas não sobrescrevem nem apagam a sessão vencedora.
import { randomBytes } from "node:crypto";

const SLOT_RE = /^[a-z0-9]{10}$/;
const ID_RE = /^[A-Za-z0-9_-]{43}$/;
const SLOT_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

export function newCookieName(config) {
  const bytes = randomBytes(10);
  let slot = "";
  for (const b of bytes) slot += SLOT_ALPHABET[b % SLOT_ALPHABET.length];
  return `${config.cookie.name}_${slot}`;
}

/** Cookie de sessão (só o identificador opaco; nunca tokens). */
export function sessionCookie(config, name, value, maxAgeSeconds) {
  const parts = [`${name}=${value}`, "Path=/", "HttpOnly", `SameSite=${config.cookie.sameSite}`];
  if (config.cookie.secure) parts.push("Secure");
  parts.push(`Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`);
  return parts.join("; ");
}

/** Apaga UM cookie pelo nome (nunca "todos os cookies de sessão"). */
export function clearCookie(config, name) {
  return sessionCookie(config, name, "", 0);
}

// Identificador ESTÁVEL do navegador (não é credencial: sozinho não dá acesso a nada). Permite que
// um logout encerre também a sessão que substituiu a do cookie que ele carregava (login
// concorrente já publicado), sem registros com TTL. Nunca é apagado por respostas atrasadas.
export function browserCookieName(config) {
  return `${config.cookie.name.replace(/_sid$/, "")}_bid`;
}

export function newBrowserId() {
  return randomBytes(32).toString("base64url");
}

export function browserCookie(config, value) {
  return sessionCookie(config, browserCookieName(config), value, 180 * 24 * 3600);
}

export function readBrowserId(cookieHeader, config) {
  if (!cookieHeader) return null;
  const name = browserCookieName(config);
  for (const part of cookieHeader.split(";")) {
    const idx = part.indexOf("=");
    if (idx > 0 && part.slice(0, idx).trim() === name) {
      const v = part.slice(idx + 1).trim();
      return ID_RE.test(v) ? v : null;
    }
  }
  return null;
}

/**
 * Cookies de sessão do PrazoAI presentes na requisição (formato estrito do nome). O valor pode
 * ser inválido; quem decide se está vivo é o armazenamento de sessões.
 * @returns {Array<{ name: string, value: string, wellFormed: boolean }>}
 */
export function readSessionCookies(cookieHeader, config) {
  if (!cookieHeader) return [];
  const prefix = `${config.cookie.name}_`;
  const out = [];
  for (const part of cookieHeader.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    const name = part.slice(0, idx).trim();
    if (!name.startsWith(prefix) || !SLOT_RE.test(name.slice(prefix.length))) continue;
    if (out.length >= 16) break;                       // limite defensivo por requisição
    const value = part.slice(idx + 1).trim();
    out.push({ name, value, wellFormed: ID_RE.test(value) });
  }
  return out;
}

export const NO_STORE = { "cache-control": "no-store, private", pragma: "no-cache" };
