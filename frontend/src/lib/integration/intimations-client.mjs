// Chamadas da 6.4 ao BFF para intimações. Só METADADOS declarados: nenhum byte do arquivo.
import { canonicalQuery } from "./deadlines-client.mjs";

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
function id(value) {
  if (typeof value !== "string" || !ID_RE.test(value)) throw new Error("identificador inválido");
  return value;
}
export const INTIMATION_LIST_PARAMS = Object.freeze(["scope", "status", "q", "page", "perPage"]);
const REGISTER_FIELDS = ["fileName", "sizeBytes", "contentType", "receivedAt", "suggestedResponsibleId"];

export function createIntimationsClient(api) {
  const P = (path) => `/bff/api${path}`;
  const withQuery = (path, q) => (q ? `${path}?${q}` : path);
  return {
    list: (params) => api.request("GET", withQuery(P("/intimations"), canonicalQuery(params, INTIMATION_LIST_PARAMS))),
    /** Registro de metadados: o corpo contém SÓ os campos do contrato (nunca conteúdo do PDF). */
    register: (scope, meta) => {
      const body = { scope };
      for (const k of REGISTER_FIELDS) if (meta[k] !== undefined && meta[k] !== "") body[k] = meta[k];
      return api.request("POST", P("/intimations"), body);
    },
    get: (intimationId) => api.request("GET", P(`/intimations/${id(intimationId)}`)),
    /** `changes`: campo ausente = manter; `null` explícito = limpar. */
    updateDraft: (intimationId, version, changes) => api.request("PATCH", P(`/intimations/${id(intimationId)}`), { version, ...changes }),
    /** Confirmação: todos os dados finais explícitos + versão (o servidor não completa nada). */
    confirm: (intimationId, version, data) => api.request("POST", P(`/intimations/${id(intimationId)}/confirm`), { version, ...data }),
    discard: (intimationId, version) => api.request("POST", P(`/intimations/${id(intimationId)}/discard`), { version }),
    history: (intimationId, page = 1, perPage = 20) =>
      api.request("GET", withQuery(P(`/intimations/${id(intimationId)}/history`), canonicalQuery({ page, perPage }, ["page", "perPage"]))),
  };
}

export function createNotificationsClient(api) {
  const P = (path) => `/bff/api${path}`;
  return {
    list: ({ scope, unreadOnly = false, page = 1, perPage = 20 }) =>
      api.request("GET", `${P("/notifications")}?${canonicalQuery({ scope, unreadOnly: unreadOnly ? "true" : undefined, page, perPage }, ["scope", "unreadOnly", "page", "perPage"])}`),
    unreadCount: (scope) => api.request("GET", `${P("/notifications/unread-count")}?${canonicalQuery({ scope }, ["scope"])}`),
    markRead: (notificationId) => api.request("POST", P(`/notifications/${id(notificationId)}/read`), {}),
    /** Marca TODAS as visíveis do ambiente informado (servidor), não só a página exibida. */
    readAll: (scope) => api.request("POST", `${P("/notifications/read-all")}?${canonicalQuery({ scope }, ["scope"])}`, {}),
  };
}

/** Destino de uma notificação (o detalhe ainda confere o ambiente real do recurso). */
export function notificationHref(n) {
  if (!ID_RE.test(n?.resourceId ?? "")) return null;
  if (n.resourceType === "deadline") return `/app/prazos/${n.resourceId}`;
  if (n.resourceType === "intimation") return `/app/intimacoes/${n.resourceId}`;
  return null;
}
