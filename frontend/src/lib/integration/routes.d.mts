export const INTEGRATED_APP_ROUTES: readonly string[];
export const UNAVAILABLE_PUBLIC: readonly string[];
export const PENDING_PUBLIC: readonly string[];
export const OLD_RESET_PAGE: string;
export type RouteDecision =
  | { action: "allow"; noReferrer?: true }
  | { action: "rewrite"; to: string; noReferrer?: true };
export function routeDecision(pathname: string, mode: string): RouteDecision;
