// Rotas do backend expostas pelo proxy na entrega 6.1 (lista EXPLÍCITA; nada além disso).
export const PROXY_ALLOWLIST = Object.freeze([
  { method: "GET", path: "/auth/me" },
  { method: "GET", path: "/users/me" },
  { method: "PATCH", path: "/users/me" },
]);

/** @returns {"ok" | "not_found" | "method_not_allowed"} */
export function matchAllowlist(method, path) {
  const sameRoute = PROXY_ALLOWLIST.filter((r) => r.path === path);
  if (sameRoute.length === 0) return "not_found";
  return sameRoute.some((r) => r.method === method) ? "ok" : "method_not_allowed";
}

/** Converte os segmentos da rota dinâmica em caminho, recusando qualquer forma suspeita. */
export function segmentsToPath(segments) {
  if (!Array.isArray(segments) || segments.length === 0 || segments.length > 8) return null;
  for (const s of segments) {
    if (typeof s !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(s)) return null;
  }
  return "/" + segments.join("/");
}
