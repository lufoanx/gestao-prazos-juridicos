// Operações PURAS de organização (escritório/equipe/convites/solicitações).
// Fonte única usada pelo OrgContext e pelos testes. Cada operação aplica as regras
// de permissão e integridade; quando bloqueada, retorna o MESMO estado (sem alterar
// dados). Estado: { offices, memberships, invites, joinRequests }.
// Não há backend nem sincronização real entre dispositivos.

const ALL_PERMS = ["deadline.read", "deadline.create", "deadline.edit", "deadline.complete", "deadline.transfer", "team.manage", "office.manage"];
const MEMBER_PERMS = ["deadline.read", "deadline.create", "deadline.edit", "deadline.complete"];
const isStr = (v) => typeof v === "string" && v.length > 0;
const leftKey = (userId, officeId) => `${userId}::${officeId}`;
const withoutTombstone = (state, userId, officeId) =>
  (state.leftKeys || []).filter((k) => k !== leftKey(userId, officeId));

function membershipOf(state, officeId, userId) {
  return (state.memberships || []).find((m) => m.officeId === officeId && m.userId === userId);
}
function adminsOf(state, officeId) {
  return (state.memberships || []).filter((m) => m.officeId === officeId && m.permissions.includes("office.manage"));
}
function has(actor, perm) { return !!actor && actor.permissions.includes(perm); }
function upsertMembership(list, m) {
  return list.some((x) => x.officeId === m.officeId && x.userId === m.userId)
    ? list.map((x) => (x.officeId === m.officeId && x.userId === m.userId ? m : x))
    : [...list, m];
}

/** A pessoa já participa de ALGUM escritório? (escritório único por pessoa) */
export function officeOfUser(state, userId) {
  return (state.memberships || []).find((m) => m.userId === userId);
}

// ----- Dados do escritório -----
export function opUpdateOffice(state, ctx, officeId, patch) {
  const actor = membershipOf(state, officeId, ctx.userId);
  if (!actor || !has(actor, "office.manage")) return state;
  const name = typeof patch?.name === "string" ? patch.name.trim() : "";
  if (name.length < 2) return state;
  return { ...state, offices: (state.offices || []).map((o) => (o.id === officeId ? { ...o, name } : o)) };
}

// ----- Equipe: cargo, áreas, visibilidade, permissões -----
export function opSetMemberProfile(state, ctx, officeId, targetUserId, patch) {
  const actor = membershipOf(state, officeId, ctx.userId);
  if (!actor || !has(actor, "team.manage")) return state;
  const target = membershipOf(state, officeId, targetUserId);
  if (!target) return state;
  const next = { ...target };
  if (typeof patch.roleLabel === "string") next.roleLabel = patch.roleLabel.trim() || target.roleLabel;
  if (Array.isArray(patch.practiceAreas)) next.practiceAreas = patch.practiceAreas.filter(isStr);
  if (patch.visibility === "all" || patch.visibility === "assigned") next.visibility = patch.visibility;
  return { ...state, memberships: upsertMembership(state.memberships, next) };
}

export function opSetMemberPermissions(state, ctx, officeId, targetUserId, permissions) {
  const actor = membershipOf(state, officeId, ctx.userId);
  if (!actor || !has(actor, "team.manage")) return state;
  const target = membershipOf(state, officeId, targetUserId);
  if (!target) return state;
  const perms = [...new Set((permissions || []).filter((p) => ALL_PERMS.includes(p)))];
  if (perms.length === 0) return state;
  // Regra: ninguém aumenta as PRÓPRIAS permissões.
  if (targetUserId === ctx.userId) {
    const gaining = perms.some((p) => !target.permissions.includes(p));
    if (gaining) return state;
  }
  // Regra: o escritório não pode ficar sem administrador.
  const losingAdmin = target.permissions.includes("office.manage") && !perms.includes("office.manage");
  if (losingAdmin && adminsOf(state, officeId).length <= 1) return state;
  return { ...state, memberships: upsertMembership(state.memberships, { ...target, permissions: perms }) };
}

// ----- Remover membro (com proteção de último admin) -----
export function opRemoveMember(state, ctx, officeId, targetUserId) {
  const actor = membershipOf(state, officeId, ctx.userId);
  if (!actor || !has(actor, "team.manage")) return state;
  const target = membershipOf(state, officeId, targetUserId);
  if (!target) return state;
  if (target.permissions.includes("office.manage") && adminsOf(state, officeId).length <= 1) return state;
  return {
    ...state,
    memberships: state.memberships.filter((m) => !(m.officeId === officeId && m.userId === targetUserId)),
    leftKeys: [...new Set([...(state.leftKeys || []), leftKey(targetUserId, officeId)])],
  };
}

/**
 * Validação TRANSACIONAL da remoção com reatribuição (pura). Não altera estado.
 * openCount = nº de prazos em aberto do alvo no escritório (vem da camada de dados).
 * Retorna { ok, reason }. Regras: quem gerencia precisa de team.manage; não remover
 * o último admin; havendo prazos em aberto, exigir reatribuição para OUTRO membro ATIVO
 * do mesmo escritório.
 */
export function validateRemoveMember(state, officeId, actorUserId, targetUserId, openCount, reassignTo) {
  const actor = membershipOf(state, officeId, actorUserId);
  if (!actor || !has(actor, "team.manage")) return { ok: false, reason: "denied" };
  const target = membershipOf(state, officeId, targetUserId);
  if (!target) return { ok: false, reason: "not-found" };
  if (target.permissions.includes("office.manage") && adminsOf(state, officeId).length <= 1) return { ok: false, reason: "last-admin" };
  if (openCount > 0) {
    if (!reassignTo) return { ok: false, reason: "needs-reassign" };
    if (reassignTo === targetUserId) return { ok: false, reason: "invalid-reassign" };
    const dest = membershipOf(state, officeId, reassignTo);
    if (!dest) return { ok: false, reason: "invalid-reassign" };
  }
  return { ok: true, reason: null };
}

// ----- Transferir administração (conceder office.manage/team.manage) -----
export function opTransferAdmin(state, ctx, officeId, targetUserId) {
  const actor = membershipOf(state, officeId, ctx.userId);
  if (!actor || !has(actor, "office.manage")) return state;
  const target = membershipOf(state, officeId, targetUserId);
  if (!target) return state;
  const perms = [...new Set([...target.permissions, "team.manage", "office.manage"])];
  return { ...state, memberships: upsertMembership(state.memberships, { ...target, permissions: perms }) };
}

// ----- Sair do escritório (último admin precisa transferir antes) -----
export function opLeaveOffice(state, ctx, officeId) {
  const actor = membershipOf(state, officeId, ctx.userId);
  if (!actor) return state;
  if (actor.permissions.includes("office.manage") && adminsOf(state, officeId).length <= 1) return state; // último admin
  return {
    ...state,
    memberships: state.memberships.filter((m) => !(m.officeId === officeId && m.userId === ctx.userId)),
    leftKeys: [...new Set([...(state.leftKeys || []), leftKey(ctx.userId, officeId)])],
  };
}

/** Validação pura da saída: bloqueia se não é membro ou é o último administrador. */
export function validateLeaveOffice(state, officeId, userId) {
  const actor = membershipOf(state, officeId, userId);
  if (!actor) return { ok: false, reason: "not-member" };
  if (actor.permissions.includes("office.manage") && adminsOf(state, officeId).length <= 1) return { ok: false, reason: "last-admin" };
  return { ok: true, reason: null };
}

/** Sair com transferência opcional, ATOMICAMENTE. Último admin precisa indicar um
 *  sucessor válido (membro ativo, ≠ ele). Em falha, retorna estado inalterado. */
export function opLeaveOrTransferOffice(state, ctx, officeId, transferTo) {
  const actor = membershipOf(state, officeId, ctx.userId);
  if (!actor) return { state, ok: false, reason: "not-member" };
  const lastAdmin = actor.permissions.includes("office.manage") && adminsOf(state, officeId).length <= 1;
  let s = state;
  if (lastAdmin) {
    const dest = membershipOf(state, officeId, transferTo);
    if (!transferTo || transferTo === ctx.userId || !dest) return { state, ok: false, reason: "last-admin" };
    s = opTransferAdmin(s, ctx, officeId, transferTo); // promove sucessor
  }
  s = {
    ...s,
    memberships: s.memberships.filter((m) => !(m.officeId === officeId && m.userId === ctx.userId)),
    leftKeys: [...new Set([...(s.leftKeys || []), leftKey(ctx.userId, officeId)])],
  };
  return { state: s, ok: true, reason: null };
}

// ----- Convites -----
export function opCreateInvite(state, ctx, officeId, deps, roleLabel) {
  const actor = membershipOf(state, officeId, ctx.userId);
  if (!actor || !has(actor, "team.manage")) return { state, invite: null };
  const invite = {
    id: deps.newId("inv"), officeId, token: deps.newId("tok"),
    expiresAt: deps.addDays(deps.today, 7), status: "pending",
    roleLabel: roleLabel || "Membro", createdAt: deps.today,
  };
  return { state: { ...state, invites: [...(state.invites || []), invite] }, invite };
}

export function opRevokeInvite(state, ctx, inviteId) {
  const inv = (state.invites || []).find((i) => i.id === inviteId);
  if (!inv) return state;
  const actor = membershipOf(state, inv.officeId, ctx.userId);
  if (!actor || !has(actor, "team.manage")) return state;
  if (inv.status !== "pending") return state;
  return { ...state, invites: state.invites.map((i) => (i.id === inviteId ? { ...i, status: "revoked" } : i)) };
}

/** Estado efetivo do convite (considera expiração por data). */
export function inviteState(invite, today) {
  if (!invite) return "invalid";
  if (invite.status === "revoked") return "revoked";
  if (invite.status === "accepted") return "used";
  if (invite.expiresAt < today) return "expired";
  return "valid";
}

/** Aceitar convite por token. Escritório único: bloqueia se já houver vínculo. */
export function opAcceptInvite(state, actorUser, token, deps) {
  const invite = (state.invites || []).find((i) => i.token === token);
  const st = inviteState(invite, deps.today);
  if (st !== "valid") return { state, officeId: null, reason: st };
  if (officeOfUser(state, actorUser.id)) return { state, officeId: null, reason: "already-member" };
  const membership = {
    userId: actorUser.id, officeId: invite.officeId, roleLabel: invite.roleLabel || "Membro",
    practiceAreas: [], permissions: [...MEMBER_PERMS], visibility: "assigned",
  };
  return {
    state: {
      ...state,
      memberships: upsertMembership(state.memberships, membership),
      invites: state.invites.map((i) => (i.id === invite.id ? { ...i, status: "accepted" } : i)),
      leftKeys: withoutTombstone(state, actorUser.id, invite.officeId),
    },
    officeId: invite.officeId, reason: null, membership,
  };
}

// ----- Solicitações de ingresso -----
export function opRequestJoin(state, actorUser, officeId, deps) {
  if (!(state.offices || []).some((o) => o.id === officeId)) return { state, id: null, reason: "invalid" };
  if (officeOfUser(state, actorUser.id)) return { state, id: null, reason: "already-member" };
  const existing = (state.joinRequests || []).find((r) => r.officeId === officeId && r.userId === actorUser.id && r.status === "pending");
  if (existing) return { state, id: existing.id, reason: "pending" };
  const req = {
    id: deps.newId("req"), officeId, userId: actorUser.id,
    name: actorUser.name || "Solicitante", email: actorUser.email || "", status: "pending", createdAt: deps.today,
  };
  return { state: { ...state, joinRequests: [...(state.joinRequests || []), req] }, id: req.id, reason: null };
}

export function opApproveRequest(state, ctx, requestId) {
  const req = (state.joinRequests || []).find((r) => r.id === requestId);
  if (!req || req.status !== "pending") return { state, reason: "invalid" };
  const actor = membershipOf(state, req.officeId, ctx.userId);
  if (!actor || !has(actor, "team.manage")) return { state, reason: "denied" };
  // Escritório único: se já entrou em outro, rejeita a solicitação.
  if (officeOfUser(state, req.userId)) {
    return { state: { ...state, joinRequests: state.joinRequests.map((r) => (r.id === requestId ? { ...r, status: "rejected" } : r)) }, reason: "already-member" };
  }
  const membership = {
    userId: req.userId, officeId: req.officeId, roleLabel: "Membro",
    practiceAreas: [], permissions: [...MEMBER_PERMS], visibility: "assigned",
  };
  return {
    state: {
      ...state,
      memberships: upsertMembership(state.memberships, membership),
      joinRequests: state.joinRequests.map((r) => (r.id === requestId ? { ...r, status: "approved" } : r)),
      leftKeys: withoutTombstone(state, req.userId, req.officeId),
    },
    reason: null,
  };
}

export function opRejectRequest(state, ctx, requestId) {
  const req = (state.joinRequests || []).find((r) => r.id === requestId);
  if (!req || req.status !== "pending") return state;
  const actor = membershipOf(state, req.officeId, ctx.userId);
  if (!actor || !has(actor, "team.manage")) return state;
  return { ...state, joinRequests: state.joinRequests.map((r) => (r.id === requestId ? { ...r, status: "rejected" } : r)) };
}

export { ALL_PERMS, MEMBER_PERMS, membershipOf, adminsOf };
