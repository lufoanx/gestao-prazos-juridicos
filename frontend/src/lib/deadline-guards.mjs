// Guarda de ESCRITA sobre prazos — lógica única, pura e testável, usada tanto
// pelo DataContext quanto pelos testes (evita duplicar a regra).
// Combina isolamento de ambiente + política de leitura + permissão exigida.
import { matchesScope } from "./deadlines-view.mjs";
import { canReadDeadline, canManageDeadline } from "./access.mjs";

// Permissão exigida por operação. Cancelar e concluir mudam status → complete.
// Editar campos → edit. Comentar/anexar/remover anexo → create.
export const OP_PERMISSION = {
  create: "deadline.create",
  edit: "deadline.edit",
  complete: "deadline.complete",
  cancel: "deadline.complete",
  reopen: "deadline.complete",
  comment: "deadline.create",
  attach: "deadline.create",
  removeAttachment: "deadline.create",
};

/** Permissão exigida por uma operação (ou null se desconhecida). */
export function permissionForOp(op) {
  return OP_PERMISSION[op] ?? null;
}

/**
 * O contexto atual pode escrever no prazo `deadline` com a permissão `perm`?
 * Exige: prazo no ambiente atual + legível + perfil com a permissão.
 * @param {object} deadline
 * @param {{ scope: object, scopeKind: "personal"|"office", userId: string, membership: object|null }} ctx
 * @param {string} perm
 */
export function canWriteDeadline(deadline, ctx, perm) {
  if (!deadline) return false;
  if (!matchesScope(deadline, ctx.scope)) return false;
  if (!canReadDeadline(ctx.userId, ctx.membership, deadline)) return false;
  if (!canManageDeadline(ctx.scopeKind, ctx.membership, perm)) return false;
  return true;
}

/** Pode criar prazo no ambiente atual (não depende de um alvo existente). */
export function canCreateDeadline(ctx) {
  return canManageDeadline(ctx.scopeKind, ctx.membership, "deadline.create");
}

/** Idem, resolvendo a permissão a partir do nome da operação. */
export function canPerformOp(deadline, ctx, op) {
  const perm = permissionForOp(op);
  if (!perm) return false;
  return canWriteDeadline(deadline, ctx, perm);
}

/** Acesso de LEITURA a uma intimação no ambiente atual (isolamento pessoal/escritório). */
export function canAccessIntimation(intimation, ctx, resolveResponsible) {
  if (!intimation) return false;
  if (!matchesScope(intimation, ctx.scope)) return false;
  if (ctx.scope.kind === "personal") return intimation.scope.ownerId === ctx.userId;
  if (!ctx.membership
    || ctx.membership.officeId !== ctx.scope.officeId
    || !ctx.membership.permissions.includes("deadline.read")) return false;
  // O autor do envio acompanha/remove o próprio item mesmo em processamento.
  if (intimation.createdBy && intimation.createdBy === ctx.userId) return true;
  // Visibilidade "all": vê todas as intimações do escritório.
  if (ctx.membership.visibility === "all") return true;
  // Visibilidade "assigned": só as suas — responsável sugerido OU prazo vinculado dele.
  if (intimation.suggestedResponsibleId && intimation.suggestedResponsibleId === ctx.userId) return true;
  if (intimation.deadlineId && typeof resolveResponsible === "function"
    && resolveResponsible(intimation.deadlineId) === ctx.userId) return true;
  return false;
}

/** Escrita sobre intimação (enviar/processar/retry/remover/confirmar) exige acesso + permissão. */
export function canWriteIntimation(intimation, ctx, perm) {
  return canAccessIntimation(intimation, ctx) && canManageDeadline(ctx.scopeKind, ctx.membership, perm);
}
