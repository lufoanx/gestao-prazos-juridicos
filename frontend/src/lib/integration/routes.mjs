// Decisão de rotas no modo integrado (entrega 6.1).
// Integrado: autenticação, sessão, perfil. Os demais módulos mostram "ainda não integrado"
// (sem dados demonstrativos). Recursos inexistentes mostram "indisponível nesta fase".
// 6.1: conta/sessão/perfil. 6.2: escritório, equipe, onboarding, convite (#TOKEN) e solicitação.
// 6.3: prazos (lista, cadastro, detalhe, edição) e calendário.
export const INTEGRATED_APP_ROUTES = Object.freeze([
  "/app", "/app/perfil", "/app/escritorio", "/app/escritorio/equipe", "/app/prazos", "/app/prazos/novo", "/app/calendario",
  // 6.4: intimações e notificações.
  "/app/intimacoes", "/app/intimacoes/upload", "/app/notificacoes",
]);
// Rotas dinâmicas integradas (segmento de id validado).
const INTEGRATED_APP_PATTERNS = Object.freeze([
  /^\/app\/prazos\/[A-Za-z0-9_-]{1,64}$/, /^\/app\/prazos\/[A-Za-z0-9_-]{1,64}\/editar$/,
  /^\/app\/intimacoes\/[A-Za-z0-9_-]{1,64}$/, /^\/app\/intimacoes\/[A-Za-z0-9_-]{1,64}\/revisao$/,
]);
// E5: a recuperação de senha está integrada; nada público fica "indisponível nesta fase".
export const UNAVAILABLE_PUBLIC = Object.freeze([]);
// E5: o link de redefinição é /redefinir-senha#TOKEN. O formato antigo (/redefinir-senha/<token>)
// não é processado em NENHUM modo: vai para uma página estática, sem eco e com no-referrer.
export const OLD_RESET_PAGE = "/redefinir-senha-antigo";
export const PENDING_PUBLIC = Object.freeze([]);

const under = (path, prefix) => path === prefix || path.startsWith(prefix + "/");

/**
 * `noReferrer`: o middleware acrescenta `Referrer-Policy: no-referrer` (telas com token de link).
 * @returns {{ action: "allow", noReferrer?: true } | { action: "rewrite", to: string, noReferrer?: true }}
 */
export function routeDecision(pathname, mode) {
  if (pathname.startsWith("/redefinir-senha/")) return { action: "rewrite", to: OLD_RESET_PAGE, noReferrer: true };
  if (pathname === "/redefinir-senha" || pathname === OLD_RESET_PAGE) return { action: "allow", noReferrer: true };
  if (mode !== "integrated") return { action: "allow" };
  if (pathname.startsWith("/bff/")) return { action: "allow" };
  if (UNAVAILABLE_PUBLIC.some((p) => under(pathname, p))) return { action: "rewrite", to: "/indisponivel" };
  if (PENDING_PUBLIC.some((p) => under(pathname, p))) return { action: "rewrite", to: "/nao-integrado" };
  // Convite no formato antigo (/convite/<token>): o token NUNCA é repassado à API.
  if (pathname.startsWith("/convite/")) return { action: "rewrite", to: "/convite-antigo" };
  if (under(pathname, "/app")) {
    if (INTEGRATED_APP_ROUTES.includes(pathname) || INTEGRATED_APP_PATTERNS.some((re) => re.test(pathname))) return { action: "allow" };
    return { action: "rewrite", to: "/app/nao-integrado" };
  }
  return { action: "allow" };
}
