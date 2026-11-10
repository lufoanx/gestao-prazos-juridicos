// Chamadas da 6.3 ao BFF (contratos de /deadlines e /calendar). Query montada de forma
// canônica (ordem fixa, sem valores vazios) — a mesma string serve de chave de cache.

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
function id(value) {
  if (typeof value !== "string" || !ID_RE.test(value)) throw new Error("identificador inválido");
  return value;
}

export const LIST_PARAMS = Object.freeze(["scope", "q", "status", "urgency", "area", "responsibleId", "dueFrom", "dueTo", "sort", "dir", "page", "perPage"]);
export const CALENDAR_PARAMS = Object.freeze(["scope", "year", "month", "status", "page", "perPage"]);

/** Query canônica: só os nomes permitidos, na ordem dada, ignorando vazios/indefinidos. */
export function canonicalQuery(params, names) {
  const out = new URLSearchParams();
  for (const name of names) {
    const v = params?.[name];
    if (v === undefined || v === null || v === "") continue;
    out.append(name, String(v));
  }
  return out.toString();
}

export function createDeadlinesClient(api) {
  const P = (path) => `/bff/api${path}`;
  const withQuery = (path, q) => (q ? `${path}?${q}` : path);
  return {
    list: (params) => api.request("GET", withQuery(P("/deadlines"), canonicalQuery(params, LIST_PARAMS))),
    create: (scope, input) => api.request("POST", P("/deadlines"), { scope, ...input }),
    get: (deadlineId) => api.request("GET", P(`/deadlines/${id(deadlineId)}`)),
    update: (deadlineId, version, changes) => api.request("PATCH", P(`/deadlines/${id(deadlineId)}`), { version, ...changes }),
    setStatus: (deadlineId, version, status, responsibleId) =>
      api.request("POST", P(`/deadlines/${id(deadlineId)}/status`), { version, status, ...(responsibleId ? { responsibleId: id(responsibleId) } : {}) }),
    // shareLinkedIntimation só é enviado quando o usuário confirmou ESPECIFICAMENTE (nunca por padrão).
    transfer: (deadlineId, version, officeId, { shareLinkedIntimation = false } = {}) =>
      api.request("POST", P(`/deadlines/${id(deadlineId)}/transfer`), {
        version, officeId: id(officeId), confirmSharing: true, ...(shareLinkedIntimation === true ? { shareLinkedIntimation: true } : {}),
      }),
    comments: (deadlineId, page = 1, perPage = 20) =>
      api.request("GET", withQuery(P(`/deadlines/${id(deadlineId)}/comments`), canonicalQuery({ page, perPage }, ["page", "perPage"]))),
    addComment: (deadlineId, text) => api.request("POST", P(`/deadlines/${id(deadlineId)}/comments`), { text }),
    history: (deadlineId, page = 1, perPage = 20) =>
      api.request("GET", withQuery(P(`/deadlines/${id(deadlineId)}/history`), canonicalQuery({ page, perPage }, ["page", "perPage"]))),
    calendar: (params) => api.request("GET", withQuery(P("/calendar"), canonicalQuery(params, CALENDAR_PARAMS))),
  };
}

/**
 * Busca TODAS as páginas de um mês do calendário (sequencial, limitado por pageCount).
 * `onPage` informa o progresso; não deriva totais de página parcial (usa total/countsByDay do servidor).
 */
export async function fetchWholeMonth(client, params, { onPage = () => {}, maxPages = 50 } = {}) {
  const first = await client.calendar({ ...params, page: 1 });
  const items = [...first.items];
  onPage(1, first.pageCount);
  let page = first;
  while (page.hasNextPage && page.nextPage && page.nextPage <= Math.min(first.pageCount, maxPages)) {
    page = await client.calendar({ ...params, page: page.nextPage });
    items.push(...page.items);
    onPage(page.page, first.pageCount);
  }
  const complete = items.length === first.total;
  return { ...first, items, page: 1, complete };
}
