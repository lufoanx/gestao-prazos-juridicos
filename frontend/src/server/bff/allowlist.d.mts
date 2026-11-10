export interface QueryRule { check(v: string): boolean; required?: boolean }
export interface AllowedRoute { method: string; path: string; query?: Record<string, QueryRule> }
export const PROXY_ALLOWLIST: ReadonlyArray<AllowedRoute>;
export function findRoute(method: string, path: string): AllowedRoute | null;
export function buildQuery(route: AllowedRoute, params: URLSearchParams): { ok: true; query: string } | { ok: false; message: string };
export function matchAllowlist(method: string, path: string): "ok" | "not_found" | "method_not_allowed";
export function segmentsToPath(segments: unknown): string | null;
