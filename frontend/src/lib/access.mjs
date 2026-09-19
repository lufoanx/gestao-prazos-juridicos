// UI demonstration policy only. Real authorization must be implemented server-side.
export function canReadDeadline(userId, membership, deadline) {
 if(deadline.scope.kind==="personal") return deadline.scope.ownerId===userId;
 if(!membership || membership.userId!==userId || membership.officeId!==deadline.scope.officeId) return false;
 return membership.permissions.includes("deadline.read") && (membership.visibility==="all" || deadline.responsibleId===userId);
}
export function canJoinOffice(membership) { return membership == null; }


// Política DEMONSTRATIVA de ação sobre prazos (a autorização real é no servidor).
// Ambiente pessoal: o dono sempre pode agir. Escritório: exige a permissão.
export function canManageDeadline(scopeKind, membership, perm) {
  if (scopeKind === "personal") return true;
  return !!membership && membership.permissions.includes(perm);
}
