// Rotas do backend expostas pelo proxy AUTENTICADO (lista EXPLÍCITA; nada além disso).
// `:id` = um segmento dinâmico validado (A-Z a-z 0-9 _ -, 1 a 64), nunca uma barra.
// 6.1: conta e perfil. 6.2: vínculo, escritório, equipe, convites (aceite) e solicitações.
// A consulta PÚBLICA de convite NÃO passa por aqui: tem rota própria (/bff/public/...).
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

/** Converte os segmentos da rota dinâmica em caminho, recusando qualquer forma suspeita. */
export function segmentsToPath(segments) {
  if (!Array.isArray(segments) || segments.length === 0 || segments.length > 8) return null;
  for (const s of segments) {
    if (typeof s !== "string" || !SEGMENT.test(s)) return null;
  }
  return "/" + segments.join("/");
}
