// Operações PURAS sobre o estado de dados (prazos/comentários/anexos/histórico).
// Fonte única usada pelo DataContext e pelos testes. Cada operação aplica a guarda
// compartilhada; quando bloqueada, retorna o MESMO estado (sem alterar dados nem
// histórico). Dependências (newId, today) são injetadas para testes determinísticos.
import { canWriteDeadline, canCreateDeadline, permissionForOp, canWriteIntimation } from "./deadline-guards.mjs";
import { sanitizePatch } from "./data-sanitize.mjs";

function mergeById(seeds, overrides) {
  const map = new Map();
  for (const s of seeds) map.set(s.id, s);
  for (const o of overrides) map.set(o.id, o);
  return [...map.values()];
}
function upsert(list, updated) {
  return list.some((d) => d.id === updated.id)
    ? list.map((d) => (d.id === updated.id ? updated : d))
    : [...list, updated];
}
const mkAudit = (ctx, deps, deadlineId, action, details) =>
  ({ id: deps.newId("h"), deadlineId, actorId: ctx.userId, action, createdAt: deps.today, details });

const findTarget = (state, seeds, id) => mergeById(seeds.deadlines, state.deadlines).find((d) => d.id === id);

/** Cria prazo no ambiente atual. Retorna { state, id } (id null se bloqueado). */
export function opCreateDeadline(state, ctx, input, deps) {
  if (!canCreateDeadline(ctx)) return { state, id: null };
  const id = deps.newId("d");
  const deadline = {
    id, scope: ctx.scope, // escopo SEMPRE do ambiente atual — nunca do input
    title: input.title.trim(), caseNumber: input.caseNumber.trim(), court: input.court.trim(),
    practiceArea: input.practiceArea, responsibleId: input.responsibleId || ctx.userId,
    status: "open", priority: input.priority,
    startDate: input.startDate, dueDate: input.dueDate,
    countingMode: input.countingMode, duration: input.duration,
    reviewed: true, agendaTime: input.agendaTime || undefined,
  };
  return {
    state: {
      ...state,
      deadlines: [...state.deadlines, deadline],
      audit: [...state.audit, mkAudit(ctx, deps, id, "created", "Prazo cadastrado")],
      notifications: [...state.notifications, {
        id: deps.newId("n"), scope: ctx.scope, title: `Novo prazo cadastrado: ${deadline.title}`,
        read: false, deadlineId: id, createdAt: deps.today,
      }],
    },
    id,
  };
}

/** Edita campos permitidos (whitelist). Preserva id, escopo e status. */
export function opUpdateDeadline(state, ctx, id, patch, deps, seeds) {
  const current = findTarget(state, seeds, id);
  if (!current || !canWriteDeadline(current, ctx, permissionForOp("edit"))) return state;
  const safe = sanitizePatch(patch);
  const updated = { ...current, ...safe, id: current.id, scope: current.scope, status: current.status };
  return { ...state, deadlines: upsert(state.deadlines, updated), audit: [...state.audit, mkAudit(ctx, deps, id, "updated", "Prazo editado")] };
}

const STATUS_OP = { completed: "complete", cancelled: "cancel", open: "reopen" };
const STATUS_LABEL = { completed: "Prazo concluído", cancelled: "Prazo cancelado", open: "Prazo reaberto" };

/** Altera status (concluir/cancelar/reabrir). Todos exigem deadline.complete. */
export function opSetStatus(state, ctx, id, status, deps, seeds) {
  const op = STATUS_OP[status];
  if (!op) return state;
  const current = findTarget(state, seeds, id);
  if (!current || !canWriteDeadline(current, ctx, permissionForOp(op))) return state;
  const updated = { ...current, status };
  const extra = status === "completed"
    ? [{ id: deps.newId("n"), scope: current.scope, title: `${STATUS_LABEL[status]}: ${current.title}`, read: false, deadlineId: id, createdAt: deps.today }]
    : [];
  return {
    ...state,
    deadlines: upsert(state.deadlines, updated),
    audit: [...state.audit, mkAudit(ctx, deps, id, status, STATUS_LABEL[status])],
    notifications: [...state.notifications, ...extra],
  };
}

export function opAddComment(state, ctx, id, text, deps, seeds) {
  const clean = String(text).trim();
  if (!clean) return state;
  const current = findTarget(state, seeds, id);
  if (!current || !canWriteDeadline(current, ctx, permissionForOp("comment"))) return state;
  return {
    ...state,
    comments: [...state.comments, { id: deps.newId("c"), deadlineId: id, authorId: ctx.userId, text: clean, createdAt: deps.today }],
    audit: [...state.audit, mkAudit(ctx, deps, id, "commented", "Comentário adicionado")],
  };
}

export function opAddAttachment(state, ctx, id, file, deps, seeds) {
  const current = findTarget(state, seeds, id);
  if (!current || !canWriteDeadline(current, ctx, permissionForOp("attach"))) return state;
  return {
    ...state,
    attachments: [...state.attachments, { id: deps.newId("a"), deadlineId: id, name: file.name, size: file.size, demoOnly: true }],
    audit: [...state.audit, mkAudit(ctx, deps, id, "attached", `Anexo (demonstrativo): ${file.name}`)],
  };
}

export function opRemoveAttachment(state, ctx, attachmentId, deps, seeds) {
  const att = mergeById(seeds.attachments, state.attachments).find((a) => a.id === attachmentId);
  if (!att) return state;
  const current = findTarget(state, seeds, att.deadlineId);
  if (!current || !canWriteDeadline(current, ctx, permissionForOp("removeAttachment"))) return state;
  return {
    ...state,
    attachments: state.attachments.filter((a) => a.id !== attachmentId),
    removedAttachmentIds: [...state.removedAttachmentIds, attachmentId],
    audit: [...state.audit, mkAudit(ctx, deps, att.deadlineId, "removed_attachment", `Anexo removido: ${att.name}`)],
  };
}

// ==========================================================================
// Intimações (Etapa 4) — extração SIMULADA (não vem do PDF; exige conferência).
// ==========================================================================
const findIntimation = (state, seeds, id) => mergeById(seeds.intimations || [], state.intimations || []).find((i) => i.id === id);

function upsertIntimation(list, updated) {
  return list.some((i) => i.id === updated.id)
    ? list.map((i) => (i.id === updated.id ? updated : i))
    : [...list, updated];
}

/** Envia um PDF (demonstrativo). Cria intimação em "processing". Requer deadline.create. */
export function opUploadIntimation(state, ctx, file, deps) {
  if (!canCreateDeadline(ctx)) return { state, id: null };
  const id = deps.newId("i");
  const intimation = {
    id, scope: ctx.scope, fileName: String(file.name), status: "processing", receivedAt: deps.today,
    createdBy: ctx.userId, // uploader acompanha/remove enquanto em processamento
    demoForceFail: !!file.demoForceFail, // desfecho simulado, persistido p/ sobreviver a reload
  };
  return { state: { ...state, intimations: [...(state.intimations || []), intimation] }, id };
}

/** Conclui o processamento SIMULADO: sucesso (awaiting_review + sugestões) ou falha. */
export function opProcessIntimation(state, ctx, id, outcome, suggestion, deps, seeds) {
  const current = findIntimation(state, seeds, id);
  if (!current || !canWriteIntimation(current, ctx, permissionForOp("create"))) return state;
  if (current.status !== "processing") return state; // só processa o que está processando
  const updated = outcome === "success"
    ? {
        ...current, status: "awaiting_review", demoForceFail: false,
        suggestedTitle: suggestion?.suggestedTitle,
        suggestedCaseNumber: suggestion?.suggestedCaseNumber,
        suggestedCourt: suggestion?.suggestedCourt,
        suggestedArea: suggestion?.suggestedArea,
        suggestedResponsibleId: suggestion?.suggestedResponsibleId,
        suggestedDueDate: suggestion?.suggestedDueDate,
      }
    : { ...current, status: "failed" };
  return { ...state, intimations: upsertIntimation(state.intimations || [], updated) };
}

/** Nova tentativa: falha → processing. Limpa o desfecho forçado (reprocessa até sucesso). */
export function opRetryIntimation(state, ctx, id, deps, seeds) {
  const current = findIntimation(state, seeds, id);
  if (!current || !canWriteIntimation(current, ctx, permissionForOp("create"))) return state;
  if (current.status !== "failed") return state;
  return { ...state, intimations: upsertIntimation(state.intimations || [], { ...current, status: "processing", demoForceFail: false }) };
}

/** Remove intimação (não confirmada). Reviewed não pode ser removida. */
export function opRemoveIntimation(state, ctx, id, deps, seeds) {
  const current = findIntimation(state, seeds, id);
  if (!current || !canWriteIntimation(current, ctx, permissionForOp("create"))) return state;
  if (current.status === "reviewed") return state; // preserva vínculo com prazo criado
  return {
    ...state,
    intimations: (state.intimations || []).filter((i) => i.id !== id),
    removedIntimationIds: [...(state.removedIntimationIds || []), id],
  };
}

/**
 * Confirma a revisão obrigatória: cria UM único prazo vinculado à intimação.
 * Proteção contra duplicação: se já revisada / já vinculada, não cria outro.
 * Retorna { state, deadlineId }.
 */
export function opConfirmIntimationReview(state, ctx, id, review, deps, seeds) {
  const current = findIntimation(state, seeds, id);
  if (!current || !canWriteIntimation(current, ctx, permissionForOp("create"))) return { state, deadlineId: null };
  // Duplicação: já confirmada.
  if (current.status === "reviewed" || current.deadlineId) return { state, deadlineId: current.deadlineId ?? null };
  if (current.status !== "awaiting_review") return { state, deadlineId: null };

  const deadlineId = deps.newId("d");
  const deadline = {
    id: deadlineId, scope: ctx.scope, // escopo do ambiente atual
    title: review.title.trim(), caseNumber: review.caseNumber.trim(), court: review.court.trim(),
    practiceArea: review.practiceArea, responsibleId: review.responsibleId || ctx.userId,
    status: "open", priority: review.priority,
    startDate: review.startDate, dueDate: review.dueDate,
    countingMode: review.countingMode, duration: review.duration,
    reviewed: true, agendaTime: review.agendaTime || undefined,
  };
  const reviewedIntimation = { ...current, status: "reviewed", deadlineId };
  return {
    state: {
      ...state,
      deadlines: [...state.deadlines, deadline],
      intimations: upsertIntimation(state.intimations || [], reviewedIntimation),
      audit: [...state.audit, mkAudit(ctx, deps, deadlineId, "created", `Criado a partir de intimação: ${current.fileName}`)],
      notifications: [...state.notifications, {
        id: deps.newId("n"), scope: ctx.scope, title: `Prazo criado da intimação: ${deadline.title}`,
        read: false, deadlineId, createdAt: deps.today,
      }],
    },
    deadlineId,
  };
}

// ==========================================================================
// Notificações (Etapa 4)
// ==========================================================================
const inScopeNotif = (n, scope) =>
  n.scope.kind === scope.kind
  && (scope.kind === "personal" ? n.scope.ownerId === scope.ownerId : n.scope.officeId === scope.officeId);

/** Marca uma notificação como lida (cópia-na-escrita para sementes). */
export function opMarkNotificationRead(state, ctx, id, seeds) {
  const merged = mergeById(seeds.notifications || [], state.notifications || []);
  const current = merged.find((n) => n.id === id);
  if (!current || !inScopeNotif(current, ctx.scope)) return state;
  if (current.read) return state;
  const updated = { ...current, read: true };
  const exists = (state.notifications || []).some((n) => n.id === id);
  return {
    ...state,
    notifications: exists ? state.notifications.map((n) => (n.id === id ? updated : n)) : [...(state.notifications || []), updated],
  };
}

/** Marca todas as notificações do ambiente atual como lidas. */
export function opMarkAllNotificationsRead(state, ctx, seeds) {
  const merged = mergeById(seeds.notifications || [], state.notifications || []);
  const targets = merged.filter((n) => inScopeNotif(n, ctx.scope) && !n.read);
  if (targets.length === 0) return state;
  let next = state.notifications || [];
  for (const t of targets) {
    const updated = { ...t, read: true };
    next = next.some((n) => n.id === t.id) ? next.map((n) => (n.id === t.id ? updated : n)) : [...next, updated];
  }
  return { ...state, notifications: next };
}

// ==========================================================================
// Transferência de prazo PESSOAL → ESCRITÓRIO (Etapa 5).
// Mantém o MESMO registro (id), comentários, anexos e histórico — não duplica.
// Exige: prazo pessoal do próprio usuário + permissão deadline.transfer no destino.
// Se houver intimação vinculada, move-a junto para manter coerência de vínculo/acesso.
// ==========================================================================
export function opTransferDeadlineToOffice(state, ctx, id, officeId, deps, seeds) {
  const current = findTarget(state, seeds, id);
  if (!current) return state;
  // Só o dono de um prazo PESSOAL pode transferir, e precisa de deadline.transfer no destino.
  if (current.scope.kind !== "personal" || current.scope.ownerId !== ctx.userId) return state;
  if (!ctx.membership || ctx.membership.officeId !== officeId) return state;
  if (!ctx.membership.permissions.includes("deadline.transfer")) return state;
  if (current.scope.kind === "office") return state; // já é do escritório

  const moved = { ...current, scope: { kind: "office", officeId } };
  // Intimação vinculada (se houver) acompanha o prazo para manter coerência.
  const linked = (state.intimations || []).find((i) => i.deadlineId === id);
  const intimations = linked
    ? upsertIntimation(state.intimations, { ...linked, scope: { kind: "office", officeId } })
    : (state.intimations || []);

  return {
    ...state,
    deadlines: upsert(state.deadlines, moved),
    intimations,
    audit: [...state.audit, mkAudit(ctx, deps, id, "transferred", "Transferido do ambiente pessoal para o escritório (compartilhado)")],
  };
}

// ==========================================================================
// Reatribuição de responsável no ESCRITÓRIO (Etapa 5, usada na remoção de membro).
// Reducer mecânico: move os prazos EM ABERTO do escritório de um responsável para
// outro. NÃO exige deadline.edit — é ação de GESTÃO DE EQUIPE (a autorização é
// verificada no coordenador, por team.manage). Retorna o MESMO estado se nada muda.
// ==========================================================================
export function opReassignResponsibleForOffice(state, ctx, officeId, fromUserId, toUserId, deps, seeds) {
  if (!toUserId || toUserId === fromUserId) return state;
  const all = mergeById(seeds.deadlines || [], state.deadlines || []);
  const targets = all.filter(
    (d) => d.scope.kind === "office" && d.scope.officeId === officeId && d.responsibleId === fromUserId && d.status === "open"
  );
  if (targets.length === 0) return state;
  let deadlines = state.deadlines || [];
  let audit = state.audit || [];
  for (const d of targets) {
    deadlines = upsert(deadlines, { ...d, responsibleId: toUserId });
    audit = [...audit, mkAudit(ctx, deps, d.id, "reassigned", `Responsável reatribuído (remoção de membro)`)];
  }
  return { ...state, deadlines, audit };
}
