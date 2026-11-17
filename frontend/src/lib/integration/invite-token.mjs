// Token de convite: vive SÓ no fragmento do navegador (#TOKEN) e no corpo da requisição.
// Nunca em pathname, query, redirect, logs ou armazenamento persistente.
// A leitura/remoção do fragmento é a mesma da redefinição de senha (fragment-token.mjs).
import { FRAGMENT_TOKEN_RE, captureFragmentToken, parseFragmentToken } from "./fragment-token.mjs";

/** Lê o token do fragmento (sem o '#'); null se ausente ou inválido. */
export const parseInviteFragment = parseFragmentToken;

/** Link de convite no formato aprovado: <origem>/convite#TOKEN. */
export function buildInviteLink(origin, token) {
  if (!FRAGMENT_TOKEN_RE.test(token)) throw new Error("token inválido");
  return `${origin.replace(/\/$/, "")}/convite#${token}`;
}

/**
 * Captura o token do fragmento e o REMOVE da barra de endereço (history.replaceState), sem
 * navegar nem gerar requisição HTTP. Retorna o token (ou null).
 */
export const captureInviteToken = captureFragmentToken;

export const INVITE_STATES = Object.freeze({
  valid: "Convite válido",
  expired: "Este convite expirou.",
  revoked: "Este convite foi revogado.",
  used: "Este convite já foi utilizado.",
  invalid: "Convite inválido.",
});
