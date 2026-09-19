// Validação e saneamento DEMONSTRATIVOS dos dados restaurados do localStorage.
// Objetivo: nunca quebrar a aplicação com dados corrompidos — registros inválidos
// são descartados individualmente, e um payload irrecuperável vira null (o chamador
// cai no estado vazio). Também define a whitelist de campos editáveis por patch,
// impedindo alteração de id ou escopo.

const STATUS = new Set(["open", "completed", "cancelled"]);
const PRIORITY = new Set(["normal", "high"]);
const COUNTING = new Set(["business", "calendar"]);
const isStr = (v) => typeof v === "string" && v.length > 0;
const isArr = Array.isArray;

/** Escopo válido: pessoal (ownerId) ou escritório (officeId). */
export function isValidScope(s) {
  if (!s || typeof s !== "object") return false;
  if (s.kind === "personal") return isStr(s.ownerId);
  if (s.kind === "office") return isStr(s.officeId);
  return false;
}

export function isValidDeadline(d) {
  return !!d && typeof d === "object"
    && isStr(d.id) && isValidScope(d.scope)
    && isStr(d.title) && typeof d.caseNumber === "string" && typeof d.court === "string"
    && typeof d.practiceArea === "string" && isStr(d.responsibleId)
    && STATUS.has(d.status) && PRIORITY.has(d.priority)
    && isStr(d.startDate) && isStr(d.dueDate) && COUNTING.has(d.countingMode)
    && typeof d.duration === "number" && Number.isFinite(d.duration);
}
const isComment = (c) => !!c && isStr(c.id) && isStr(c.deadlineId) && isStr(c.authorId) && typeof c.text === "string" && isStr(c.createdAt);
const isAttachment = (a) => !!a && isStr(a.id) && isStr(a.deadlineId) && isStr(a.name) && typeof a.size === "number";
const isAudit = (h) => !!h && isStr(h.id) && isStr(h.deadlineId) && isStr(h.actorId) && isStr(h.action) && isStr(h.createdAt);
const isNotification = (n) => !!n && isStr(n.id) && isValidScope(n.scope) && isStr(n.title) && typeof n.read === "boolean" && isStr(n.createdAt);
const INTIMATION_STATUS = new Set(["sent", "processing", "awaiting_review", "reviewed", "failed"]);
const isIntimation = (i) => !!i && isStr(i.id) && isValidScope(i.scope) && isStr(i.fileName)
  && INTIMATION_STATUS.has(i.status) && isStr(i.receivedAt);

function keepValid(list, pred) {
  return isArr(list) ? list.filter(pred) : [];
}

/**
 * Sanitiza o payload persistido. Retorna estrutura completa (todos os arrays)
 * quando a versão bate; caso contrário null (payload descartado).
 */
export function sanitizeStored(parsed, version) {
  if (!parsed || typeof parsed !== "object") return null;
  if (parsed.version !== version) return null;
  return {
    version,
    deadlines: keepValid(parsed.deadlines, isValidDeadline),
    comments: keepValid(parsed.comments, isComment),
    attachments: keepValid(parsed.attachments, isAttachment).map((a) => ({ ...a, demoOnly: true })),
    audit: keepValid(parsed.audit, isAudit),
    notifications: keepValid(parsed.notifications, isNotification),
    removedAttachmentIds: keepValid(parsed.removedAttachmentIds, isStr),
    intimations: keepValid(parsed.intimations, isIntimation),
    removedIntimationIds: keepValid(parsed.removedIntimationIds, isStr),
  };
}

// Campos que um patch de edição pode alterar. NUNCA inclui id, scope ou status
// (status muda apenas por setStatus). Impede troca de dono/escritório via patch.
export const EDITABLE_FIELDS = [
  "title", "caseNumber", "court", "practiceArea", "responsibleId",
  "priority", "startDate", "dueDate", "countingMode", "duration", "agendaTime", "reviewed",
];

/** Mantém apenas campos editáveis do patch (descarta id/scope/status e desconhecidos). */
export function sanitizePatch(patch) {
  const out = {};
  if (!patch || typeof patch !== "object") return out;
  for (const k of EDITABLE_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(patch, k) && patch[k] !== undefined) out[k] = patch[k];
  }
  return out;
}
