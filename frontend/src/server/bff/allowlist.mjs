// Rotas do backend expostas pelo proxy AUTENTICADO (lista EXPLÍCITA; nada além disso).
// `:id` = um segmento dinâmico validado (A-Z a-z 0-9 _ -, 1 a 64), nunca uma barra.
// 6.1: conta e perfil. 6.2: vínculo, escritório, equipe, convites (aceite) e solicitações.
// A consulta PÚBLICA de convite NÃO passa por aqui: tem rota própria (/bff/public/...).
// 6.3: prazos, status, transferência, comentários, histórico e calendário.
// 6.4: intimações (metadados, rascunho, confirmação, descarte, histórico) e notificações internas.
//      `retry` NÃO é exposto: o processamento não existe nesta fase e a interface não o oferece.
//
// QUERY STRINGS (6.3): só rotas com `query` aceitam parâmetros, e somente os listados, cada um com
// validador próprio (enum, inteiro com faixa, data civil, id, texto limitado). Parâmetro
// desconhecido, repetido ou inválido → 422 no próprio BFF. A query é REMONTADA pelo BFF
// (URLSearchParams, na ordem da especificação); nada do cliente altera host, caminho ou destino.
// Rotas sem `query` (6.1/6.2) continuam ignorando a query recebida, como antes.
const enumOf = (...values) => (v) => values.includes(v);
const intIn = (min, max) => (v) => /^[0-9]{1,6}$/.test(v) && Number(v) >= min && Number(v) <= max;
const civilDate = (v) => /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(v);
const idValue = (v) => /^[A-Za-z0-9_-]{1,64}$/.test(v);
const text = (max) => (v) => v.length >= 1 && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v);

const STATUS = enumOf("open", "completed", "cancelled");
const PAGE = { check: intIn(1, 100000) };
const LIST_QUERY = Object.freeze({
  scope: { check: enumOf("personal", "office"), required: true },
  q: { check: text(100) },
  status: { check: STATUS },
  urgency: { check: enumOf("overdue", "today", "soon", "upcoming") },
  area: { check: text(60) },
  responsibleId: { check: idValue },
  dueFrom: { check: civilDate },
  dueTo: { check: civilDate },
  sort: { check: enumOf("dueDate", "title", "priority", "status", "createdAt") },
  dir: { check: enumOf("asc", "desc") },
  page: PAGE,
  perPage: { check: intIn(1, 100) },
});
const PAGED_QUERY = Object.freeze({ page: PAGE, perPage: { check: intIn(1, 100) } });
const CALENDAR_QUERY = Object.freeze({
  scope: { check: enumOf("personal", "office"), required: true },
  year: { check: intIn(2000, 2100), required: true },
  month: { check: intIn(1, 12), required: true },
  status: { check: STATUS },
  page: PAGE,
  perPage: { check: intIn(1, 500) },
});

const SCOPE_REQUIRED = { check: enumOf("personal", "office"), required: true };
const INTIMATION_LIST_QUERY = Object.freeze({
  scope: SCOPE_REQUIRED,
  status: { check: enumOf("processing", "awaiting_review", "failed", "reviewed", "discarded") },
  q: { check: text(100) },
  page: PAGE,
  perPage: { check: intIn(1, 100) },
});
const NOTIFICATION_LIST_QUERY = Object.freeze({
  scope: SCOPE_REQUIRED,
  unreadOnly: { check: enumOf("true", "false") },
  page: PAGE,
  perPage: { check: intIn(1, 100) },
});
const SCOPE_ONLY_QUERY = Object.freeze({ scope: SCOPE_REQUIRED });

export const PROXY_ALLOWLIST = Object.freeze([
  // 6.1
  { method: "GET", path: "/auth/me" },
  { method: "GET", path: "/users/me" },
  { method: "PATCH", path: "/users/me" },
  // 6.2 — vínculo e escritório
  { method: "GET", path: "/memberships/me" },
  { method: "POST", path: "/offices" },
  { method: "GET", path: "/offices/:id" },
  { method: "PATCH", path: "/offices/:id" },
  // 6.2 — equipe
  { method: "GET", path: "/offices/:id/members" },
  { method: "PATCH", path: "/offices/:id/members/:id" },
  { method: "POST", path: "/offices/:id/members/:id/promote" },
  { method: "POST", path: "/offices/:id/members/:id/remove" },
  { method: "POST", path: "/offices/:id/leave" },
  // 6.2 — código de ingresso, convites e solicitações
  { method: "GET", path: "/offices/:id/join-code" },
  { method: "POST", path: "/offices/:id/join-code/rotate" },
  { method: "GET", path: "/offices/:id/invitations" },
  { method: "POST", path: "/offices/:id/invitations" },
  { method: "POST", path: "/offices/:id/invitations/:id/revoke" },
  { method: "GET", path: "/offices/:id/join-requests" },
  { method: "POST", path: "/offices/:id/join-requests/:id/approve" },
  { method: "POST", path: "/offices/:id/join-requests/:id/reject" },
  { method: "POST", path: "/invitations/accept" },
  { method: "POST", path: "/join-requests" },
  { method: "GET", path: "/join-requests/me" },
  { method: "POST", path: "/join-requests/:id/cancel" },
  // 6.3 — prazos e calendário
  { method: "GET", path: "/deadlines", query: LIST_QUERY },
  { method: "POST", path: "/deadlines" },
  { method: "GET", path: "/deadlines/:id" },
  { method: "PATCH", path: "/deadlines/:id" },
  { method: "POST", path: "/deadlines/:id/status" },
  { method: "POST", path: "/deadlines/:id/transfer" },
  { method: "GET", path: "/deadlines/:id/comments", query: PAGED_QUERY },
  { method: "POST", path: "/deadlines/:id/comments" },
  { method: "GET", path: "/deadlines/:id/history", query: PAGED_QUERY },
  { method: "GET", path: "/calendar", query: CALENDAR_QUERY },
  // 6.4 — intimações (somente metadados declarados; nenhum arquivo trafega)
  { method: "GET", path: "/intimations", query: INTIMATION_LIST_QUERY },
  { method: "POST", path: "/intimations" },
  { method: "GET", path: "/intimations/:id" },
  { method: "PATCH", path: "/intimations/:id" },
  { method: "POST", path: "/intimations/:id/confirm" },
  { method: "POST", path: "/intimations/:id/discard" },
  { method: "GET", path: "/intimations/:id/history", query: PAGED_QUERY },
  // 6.4 — notificações internas (por destinatário; autorização atual decidida no servidor)
  { method: "GET", path: "/notifications", query: NOTIFICATION_LIST_QUERY },
  { method: "GET", path: "/notifications/unread-count", query: SCOPE_ONLY_QUERY },
  { method: "POST", path: "/notifications/:id/read" },
  { method: "POST", path: "/notifications/read-all", query: SCOPE_ONLY_QUERY },
]);

const SEGMENT = /^[A-Za-z0-9_-]{1,64}$/;

function matches(pattern, path) {
  const p = pattern.split("/");
  const a = path.split("/");
  if (p.length !== a.length) return false;
  return p.every((seg, i) => (seg === ":id" ? SEGMENT.test(a[i]) : seg === a[i]));
}

/** @returns {"ok" | "not_found" | "method_not_allowed"} */
export function matchAllowlist(method, path) {
  const sameRoute = PROXY_ALLOWLIST.filter((r) => matches(r.path, path));
  if (sameRoute.length === 0) return "not_found";
  return sameRoute.some((r) => r.method === method) ? "ok" : "method_not_allowed";
}

export function findRoute(method, path) {
  return PROXY_ALLOWLIST.find((r) => r.method === method && matches(r.path, path)) ?? null;
}

/**
 * Valida e REMONTA a query de uma rota da allowlist.
 * @param {{ query?: Record<string, { check: (v: string) => boolean, required?: boolean }> }} route
 * @param {URLSearchParams} params
 * @returns {{ ok: true, query: string } | { ok: false, message: string }}
 */
export function buildQuery(route, params) {
  const spec = route.query;
  if (!spec) return { ok: true, query: "" };                 // rotas antigas: query ignorada (comportamento anterior)
  const seen = new Map();
  for (const [name, value] of params) {
    if (!Object.hasOwn(spec, name)) return { ok: false, message: `Parâmetro não permitido: ${name.slice(0, 40)}` };
    if (seen.has(name)) return { ok: false, message: `Parâmetro repetido: ${name}` };
    if (!spec[name].check(value)) return { ok: false, message: `Valor inválido para ${name}.` };
    seen.set(name, value);
  }
  for (const [name, rule] of Object.entries(spec)) {
    if (rule.required && !seen.has(name)) return { ok: false, message: `Parâmetro obrigatório: ${name}` };
  }
  const out = new URLSearchParams();
  for (const name of Object.keys(spec)) if (seen.has(name)) out.append(name, seen.get(name));
  return { ok: true, query: out.toString() };
}

/** Converte os segmentos da rota dinâmica em caminho, recusando qualquer forma suspeita. */
export function segmentsToPath(segments) {
  if (!Array.isArray(segments) || segments.length === 0 || segments.length > 8) return null;
  for (const s of segments) {
    if (typeof s !== "string" || !SEGMENT.test(s)) return null;
  }
  return "/" + segments.join("/");
}
