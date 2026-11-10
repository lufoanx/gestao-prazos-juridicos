// Capacidades de INTIMAÇÃO para exibir controles (o servidor decide). Espelham
// backend/app/policies/intimations.py — não são as permissões de prazos copiadas:
// - leitura: decidida pelo servidor (se a resposta chegou, há leitura);
// - escrita (rascunho/confirmar): leitura + deadline.create (pessoal: só o dono);
// - descartar: escrita + ser autor ou ter visibilidade "all";
// - confirmar: além disso, as regras de criação de prazo (deadline.create + deadline.read).
// Cargo e gestão de equipe não concedem nada.
import { scopeMatches } from "./deadline-caps.mjs";

export const PENDING = Object.freeze(["processing", "awaiting_review", "failed"]);

export function intimationCaps(i, membership, userId) {
  const none = { canEditDraft: false, canConfirm: false, canDiscard: false, canRetry: false };
  if (!i?.scope) return none;
  let write = false;
  let ownerOrAll = false;
  if (i.scope.kind === "personal") {
    write = i.scope.ownerId === userId;
    ownerOrAll = write;
  } else if (membership && membership.officeId === i.scope.officeId) {
    const p = new Set(membership.permissions ?? []);
    write = p.has("deadline.read") && p.has("deadline.create");
    ownerOrAll = i.createdBy === userId || membership.visibility === "all";
  }
  return {
    canEditDraft: write && i.status === "awaiting_review",
    canConfirm: write && i.status === "awaiting_review",
    canDiscard: write && ownerOrAll && PENDING.includes(i.status),
    // Só faria sentido com processamento real; nesta fase o servidor não processa (não oferecido).
    canRetry: write && ownerOrAll && i.status === "failed" && i.processing?.status === "failed",
  };
}

/** Pode registrar no ambiente? Pessoal: sempre. Escritório: deadline.create + deadline.read. */
export function canRegisterIntimation(scope, membership) {
  if (scope === "personal") return true;
  const p = new Set(membership?.permissions ?? []);
  return Boolean(membership) && p.has("deadline.read") && p.has("deadline.create");
}

export { scopeMatches };

const DRAFT_KEYS = ["title", "caseNumber", "court", "practiceArea", "startDate", "dueDate", "countingMode", "duration", "priority", "agendaTime"];

/**
 * Diferença do rascunho para o PATCH: campo inalterado é OMITIDO; campo apagado vira `null`
 * explícito (limpar); demais enviam o novo valor. `suggestedResponsibleId` segue a mesma regra.
 */
export function draftChanges(original, form, originalSuggested, formSuggested) {
  const out = {};
  for (const k of DRAFT_KEYS) {
    const before = original?.[k] ?? null;
    let after = form?.[k];
    if (after === "" || after === undefined) after = null;
    if (k === "duration" && after !== null) after = Number(after);
    if (after !== before) out[k] = after;
  }
  const s = formSuggested || null;
  if (s !== (originalSuggested ?? null)) out.suggestedResponsibleId = s;
  return out;
}
