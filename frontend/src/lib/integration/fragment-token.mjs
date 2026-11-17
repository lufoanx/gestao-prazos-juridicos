// Token opaco no FRAGMENTO da URL (#TOKEN): padrão dos convites (6.2), reaproveitado pela
// redefinição de senha (E5). O fragmento não é enviado ao servidor; a página o lê, remove-o da barra
// com history.replaceState (sem navegar e sem requisição HTTP) e mantém o token só em memória.
// Nunca em pathname, query, redirect, cookie, localStorage, sessionStorage, DOM ou logs.

// Tokens emitidos pelo backend: secrets.token_urlsafe → base64url; 16..256 caracteres.
export const FRAGMENT_TOKEN_RE = /^[A-Za-z0-9_-]{16,256}$/;

/** Lê o token do fragmento (sem o '#'); null se ausente ou malformado. */
export function parseFragmentToken(hash) {
  if (typeof hash !== "string" || !hash.startsWith("#")) return null;
  const raw = hash.slice(1);
  return FRAGMENT_TOKEN_RE.test(raw) ? raw : null;
}

/**
 * Lê o fragmento e o REMOVE da barra (inclusive quando malformado), deixando só o caminho na
 * entrada atual do histórico. Retorna o token ou null.
 */
export function captureFragmentToken(win) {
  const token = parseFragmentToken(win.location.hash);
  if (win.location.hash) win.history.replaceState(null, "", win.location.pathname);
  return token;
}

/**
 * Captura IDEMPOTENTE para componentes React: renderizações e efeitos repetidos (StrictMode,
 * remontagem do efeito) não perdem o token nem o leem duas vezes. A primeira chamada de `capture`
 * lê e limpa a barra; as seguintes devolvem o mesmo resultado, exceto quando um NOVO fragmento
 * aparece na barra (outro link aberto na mesma aba: `hashchange`), que substitui o anterior.
 */
export function createFragmentTokenHolder() {
  let captured = false;
  let token = null;
  return {
    /** @returns {{ token: string | null, fresh: boolean }} fresh = leitura nova da barra */
    capture(win) {
      if (!captured || win.location.hash) {
        token = captureFragmentToken(win);
        captured = true;
        return { token, fresh: true };
      }
      return { token, fresh: false };
    },
    /** Token atual em memória (somente para o corpo da requisição). */
    get token() { return token; },
    /** Descarta o token (sucesso, link recusado). */
    clear() { token = null; },
  };
}
