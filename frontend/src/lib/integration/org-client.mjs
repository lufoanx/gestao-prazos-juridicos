// Chamadas da 6.2 ao BFF (contratos de escritórios/equipe/convites/solicitações).
// IDs são validados antes de compor o caminho; nada vem pronto do usuário.

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
function id(value) {
  if (typeof value !== "string" || !ID_RE.test(value)) throw new Error("identificador inválido");
  return value;
}

export function createOrgClient(api) {
  const P = (path) => `/bff/api${path}`;
  return {
    membership: () => api.request("GET", P("/memberships/me")),
    createOffice: (body) => api.request("POST", P("/offices"), body),
    office: (officeId) => api.request("GET", P(`/offices/${id(officeId)}`)),
    renameOffice: (officeId, name) => api.request("PATCH", P(`/offices/${id(officeId)}`), { name }),
    members: (officeId) => api.request("GET", P(`/offices/${id(officeId)}/members`)),
    updateMember: (officeId, userId, body) => api.request("PATCH", P(`/offices/${id(officeId)}/members/${id(userId)}`), body),
    promote: (officeId, userId) => api.request("POST", P(`/offices/${id(officeId)}/members/${id(userId)}/promote`), {}),
    removeMember: (officeId, userId, reassignTo) =>
      api.request("POST", P(`/offices/${id(officeId)}/members/${id(userId)}/remove`), reassignTo ? { reassignTo: id(reassignTo) } : {}),
    leave: (officeId, { successorUserId, reassignTo } = {}) =>
      api.request("POST", P(`/offices/${id(officeId)}/leave`), {
        ...(successorUserId ? { successorUserId: id(successorUserId) } : {}),
        ...(reassignTo ? { reassignTo: id(reassignTo) } : {}),
      }),
    joinCode: (officeId) => api.request("GET", P(`/offices/${id(officeId)}/join-code`)),
    rotateJoinCode: (officeId) => api.request("POST", P(`/offices/${id(officeId)}/join-code/rotate`), {}),
    invitations: (officeId) => api.request("GET", P(`/offices/${id(officeId)}/invitations`)),
    createInvitation: (officeId, roleLabel) => api.request("POST", P(`/offices/${id(officeId)}/invitations`), roleLabel ? { roleLabel } : {}),
    revokeInvitation: (officeId, invitationId) =>
      api.request("POST", P(`/offices/${id(officeId)}/invitations/${id(invitationId)}/revoke`), {}),
    officeRequests: (officeId) => api.request("GET", P(`/offices/${id(officeId)}/join-requests`)),
    approveRequest: (officeId, requestId) => api.request("POST", P(`/offices/${id(officeId)}/join-requests/${id(requestId)}/approve`), {}),
    rejectRequest: (officeId, requestId) => api.request("POST", P(`/offices/${id(officeId)}/join-requests/${id(requestId)}/reject`), {}),
    // Token do convite: SOMENTE no corpo; consulta pública por rota própria.
    lookupInvitation: (token) => api.request("POST", "/bff/public/invitations/lookup", { token }),
    acceptInvitation: (token) => api.request("POST", P("/invitations/accept"), { token }),
    requestJoin: (joinCode) => api.request("POST", P("/join-requests"), { joinCode }),
    myRequests: () => api.request("GET", P("/join-requests/me")),
    cancelRequest: (requestId) => api.request("POST", P(`/join-requests/${id(requestId)}/cancel`), {}),
  };
}
