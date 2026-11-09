// Decisão de rotas no modo integrado (entrega 6.1).
// Integrado: autenticação, sessão, perfil. Os demais módulos mostram "ainda não integrado"
// (sem dados demonstrativos). Recursos inexistentes mostram "indisponível nesta fase".
export const INTEGRATED_APP_ROUTES = Object.freeze(["/app", "/app/perfil"]);
export const UNAVAILABLE_PUBLIC = Object.freeze(["/esqueci-senha", "/redefinir-senha"]);
export const PENDING_PUBLIC = Object.freeze(["/onboarding", "/convite", "/solicitar-ingresso"]);

const under = (path, prefix) => path === prefix || path.startsWith(prefix + "/");

/** @returns {{ action: "allow" } | { action: "rewrite", to: string }} */
export function routeDecision(pathname, mode) {
  if (mode !== "integrated") return { action: "allow" };
  if (pathname.startsWith("/bff/")) return { action: "allow" };
  if (UNAVAILABLE_PUBLIC.some((p) => under(pathname, p))) return { action: "rewrite", to: "/indisponivel" };
  if (PENDING_PUBLIC.some((p) => under(pathname, p))) return { action: "rewrite", to: "/nao-integrado" };
  if (under(pathname, "/app")) {
    if (INTEGRATED_APP_ROUTES.includes(pathname)) return { action: "allow" };
    return { action: "rewrite", to: "/app/nao-integrado" };
  }
  return { action: "allow" };
}
