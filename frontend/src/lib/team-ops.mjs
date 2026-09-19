// Operação COORDENADA de remoção de membro com reatribuição (Etapa 5).
// Combina roster (org) + prazos (data) numa única transação PURA: valida
// permissão, último administrador, prazos em aberto e destinatário ativo do MESMO
// escritório; só então aplica reatribuição (dos prazos em aberto do escritório) e
// remoção. Em QUALQUER falha, retorna os estados inalterados (nenhuma mudança) e
// ok=false com o motivo. A reatribuição NÃO exige deadline.edit (é gestão de equipe).
import { validateRemoveMember, opRemoveMember } from "./org-ops.mjs";
import { opReassignResponsibleForOffice } from "./data-ops.mjs";

/** Conta prazos EM ABERTO do escritório atribuídos a um responsável. */
export function openOfficeDeadlinesFor(dataState, seeds, officeId, userId) {
  const merge = new Map();
  for (const d of (seeds?.deadlines || [])) merge.set(d.id, d);
  for (const d of (dataState.deadlines || [])) merge.set(d.id, d);
  return [...merge.values()].filter(
    (d) => d.scope.kind === "office" && d.scope.officeId === officeId && d.responsibleId === userId && d.status === "open"
  );
}

/**
 * @returns { org, data, ok, reason }
 * ok=false ⇒ org/data são exatamente os recebidos (identidade preservada).
 */
export function coordinateRemoveMember(org, data, actorId, { officeId, userId, reassignTo }, deps, seeds) {
  const open = openOfficeDeadlinesFor(data, seeds, officeId, userId);
  const check = validateRemoveMember(org, officeId, actorId, userId, open.length, reassignTo);
  if (!check.ok) return { org, data, ok: false, reason: check.reason };

  // Aplica reatribuição (se houver prazos em aberto) e remoção — como unidade.
  const ctx = { userId: actorId };
  const dataNext = open.length > 0
    ? opReassignResponsibleForOffice(data, ctx, officeId, userId, reassignTo, deps, seeds)
    : data;
  const orgNext = opRemoveMember(org, ctx, officeId, userId);

  // Salvaguarda: se a remoção não foi aplicada (guarda interna), não altera nada.
  if (orgNext === org) return { org, data, ok: false, reason: "denied" };
  return { org: orgNext, data: dataNext, ok: true, reason: null };
}
