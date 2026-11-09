export const INTEGRATED_APP_ROUTES: readonly string[];
export const UNAVAILABLE_PUBLIC: readonly string[];
export const PENDING_PUBLIC: readonly string[];
export function routeDecision(pathname: string, mode: string): { action: "allow" } | { action: "rewrite"; to: string };
