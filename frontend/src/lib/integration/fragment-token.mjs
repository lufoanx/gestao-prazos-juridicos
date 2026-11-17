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
 *
 * Cada leitura nova recebe uma REVISÃO (1, 2, …). Quem usa o token guarda a revisão da captura que
 * o originou; `clear(revisão)` só descarta o token se ele ainda for daquela captura — a resposta de
 * uma tentativa feita com o link anterior nunca apaga o link novo (doc 21, §23).
 */
export function createFragmentTokenHolder() {
  let revision = 0;
  let token = null;
  return {
    /** @returns {{ token: string | null, fresh: boolean, revision: number }} fresh = leitura nova da barra */
    capture(win) {
      if (revision === 0 || win.location.hash) {
        token = captureFragmentToken(win);
        revision += 1;
        return { token, fresh: true, revision };
      }
      return { token, fresh: false, revision };
    },
    /** Token atual em memória (somente para o corpo da requisição). */
    get token() { return token; },
    /** Revisão da captura atual (0 = nada lido ainda). */
    get revision() { return revision; },
    /** Descarta o token SE ainda for o da captura `rev` (sucesso, link recusado). @returns {boolean} */
    clear(rev) {
      if (rev !== revision) return false;
      token = null;
      return true;
    },
  };
}
