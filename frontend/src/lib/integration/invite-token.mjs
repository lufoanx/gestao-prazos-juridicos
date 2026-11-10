// Token de convite: vive SÓ no fragmento do navegador (#TOKEN) e no corpo da requisição.
// Nunca em pathname, query, redirect, logs ou armazenamento persistente.

const TOKEN_RE = /^[A-Za-z0-9_-]{16,256}$/;

/** Lê o token do fragmento (sem o '#'); null se ausente ou inválido. */
export function parseInviteFragment(hash) {
  if (typeof hash !== "string" || !hash.startsWith("#")) return null;
  const raw = hash.slice(1);
  return TOKEN_RE.test(raw) ? raw : null;
}

/** Link de convite no formato aprovado: <origem>/convite#TOKEN. */
export function buildInviteLink(origin, token) {
  if (!TOKEN_RE.test(token)) throw new Error("token inválido");
  return `${origin.replace(/\/$/, "")}/convite#${token}`;
}

/**
 * Captura o token do fragmento e o REMOVE da barra de endereço (history.replaceState), sem
 * navegar nem gerar requisição HTTP. Retorna o token (ou null).
 */
export function captureInviteToken(win) {
  const token = parseInviteFragment(win.location.hash);
  if (win.location.hash) win.history.replaceState(null, "", win.location.pathname);
  return token;
}

export const INVITE_STATES = Object.freeze({
  valid: "Convite válido",
  expired: "Este convite expirou.",
  revoked: "Este convite foi revogado.",
  used: "Este convite já foi utilizado.",
  invalid: "Convite inválido.",
});
