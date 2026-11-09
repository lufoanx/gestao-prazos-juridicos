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

/** Cookie de sessão (só o identificador opaco; nunca tokens). */
export function sessionCookie(config, value, maxAgeSeconds) {
  const parts = [`${config.cookie.name}=${value}`, "Path=/", "HttpOnly", `SameSite=${config.cookie.sameSite}`];
  if (config.cookie.secure) parts.push("Secure");
  parts.push(`Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`);
  return parts.join("; ");
}

export function clearSessionCookie(config) {
  return sessionCookie(config, "", 0);
}

/** Lê o identificador da sessão do cabeçalho Cookie (formato estrito). */
export function readSessionId(cookieHeader, config) {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    if (part.slice(0, idx).trim() === config.cookie.name) {
      const v = part.slice(idx + 1).trim();
      return /^[A-Za-z0-9_-]{43}$/.test(v) ? v : null;
    }
  }
  return null;
}

export const NO_STORE = { "cache-control": "no-store, private", pragma: "no-cache" };
