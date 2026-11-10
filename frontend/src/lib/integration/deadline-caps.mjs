// Capacidades para EXIBIR controles de prazos (o servidor decide de verdade). Espelham
// backend/app/policies/deadlines.py: pessoal = só o dono (tudo); escritório = vínculo atual +
// deadline.read + permissão da operação. Cargo, autoria e gestão de equipe não contam.

export function deadlineCaps(scope, membership) {
  if (scope === "personal") {
    return { canRead: true, canCreate: true, canEdit: true, canComplete: true, canComment: true, canTransferOut: false, visibilityAll: true };
  }
  const p = new Set(membership?.permissions ?? []);
  const read = p.has("deadline.read");
  return {
    canRead: read,
    canCreate: read && p.has("deadline.create"),
    canEdit: read && p.has("deadline.edit"),
    canComplete: read && p.has("deadline.complete"),
    canComment: read && p.has("deadline.create"),
    canTransferOut: false,
    visibilityAll: membership?.visibility === "all",
  };
}

/** Pode transferir prazos PESSOAIS para o escritório atual (deadline.transfer + deadline.read). */
export function canTransferToOffice(membership) {
  const p = new Set(membership?.permissions ?? []);
  return Boolean(membership) && p.has("deadline.transfer") && p.has("deadline.read");
}

/**
 * Responsáveis selecionáveis: pessoal → só o dono; escritório com visibilidade "assigned" → só a
 * própria pessoa; "all" → membros atuais (projeção autorizada da equipe). Sem ids como rótulo.
 */
export function selectableResponsibles(scope, membership, members, me) {
  if (scope === "personal" || membership?.visibility !== "all") return [{ userId: me.id, name: me.name }];
  return (members ?? []).map((m) => ({ userId: m.userId, name: m.name }));
}

/** Nome para exibição sem expor identificadores: quem não está na projeção vira rótulo genérico. */
export function displayName(userId, names, me) {
  if (me && userId === me.id) return `${me.name} (você)`;
  return names?.get?.(userId) ?? "Pessoa fora do escritório";
}

/**
 * O prazo pertence ao ambiente SELECIONADO? (pessoal: dono atual; escritório: o escritório do
 * vínculo atual). Sem correspondência, a tela não renderiza dados, formulários nem ações.
 */
export function scopeMatches(deadline, { scope, officeId, userId }) {
  if (!deadline?.scope) return false;
  if (deadline.scope.kind === "personal") return scope === "personal" && deadline.scope.ownerId === userId;
  return scope === "office" && Boolean(officeId) && deadline.scope.officeId === officeId;
}

/**
 * Capacidades pelo RECURSO real + usuário + vínculo atual (nunca só pela preferência de navegação).
 * Pessoal: tudo só para o dono. Escritório: só com vínculo atual NO MESMO escritório do prazo.
 */
export function resourceCaps(deadline, membership, userId) {
  const none = { canRead: false, canCreate: false, canEdit: false, canComplete: false, canComment: false, canTransferOut: false, visibilityAll: false };
  if (!deadline?.scope) return none;
  if (deadline.scope.kind === "personal") {
    return deadline.scope.ownerId === userId
      ? { ...deadlineCaps("personal", null), canTransferOut: canTransferToOffice(membership) }
      : none;
  }
  if (!membership || membership.officeId !== deadline.scope.officeId) return none;
  return deadlineCaps("office", membership);
}
