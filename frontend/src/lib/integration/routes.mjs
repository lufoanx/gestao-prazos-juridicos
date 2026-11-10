// Decisão de rotas no modo integrado (entrega 6.1).
// Integrado: autenticação, sessão, perfil. Os demais módulos mostram "ainda não integrado"
// (sem dados demonstrativos). Recursos inexistentes mostram "indisponível nesta fase".
// 6.1: conta/sessão/perfil. 6.2: escritório, equipe, onboarding, convite (#TOKEN) e solicitação.
export const INTEGRATED_APP_ROUTES = Object.freeze(["/app", "/app/perfil", "/app/escritorio", "/app/escritorio/equipe"]);
export const UNAVAILABLE_PUBLIC = Object.freeze(["/esqueci-senha", "/redefinir-senha"]);
export const PENDING_PUBLIC = Object.freeze([]);

const under = (path, prefix) => path === prefix || path.startsWith(prefix + "/");

/** @returns {{ action: "allow" } | { action: "rewrite", to: string }} */
export function routeDecision(pathname, mode) {
  if (mode !== "integrated") return { action: "allow" };
  if (pathname.startsWith("/bff/")) return { action: "allow" };
  if (UNAVAILABLE_PUBLIC.some((p) => under(pathname, p))) return { action: "rewrite", to: "/indisponivel" };
  if (PENDING_PUBLIC.some((p) => under(pathname, p))) return { action: "rewrite", to: "/nao-integrado" };
  // Convite no formato antigo (/convite/<token>): o token NUNCA é repassado à API.
  if (pathname.startsWith("/convite/")) return { action: "rewrite", to: "/convite-antigo" };
  if (under(pathname, "/app")) {
    if (INTEGRATED_APP_ROUTES.includes(pathname)) return { action: "allow" };
    return { action: "rewrite", to: "/app/nao-integrado" };
  }
  return { action: "allow" };
}
