export const PROXY_ALLOWLIST: ReadonlyArray<{ method: string; path: string }>;
export function matchAllowlist(method: string, path: string): "ok" | "not_found" | "method_not_allowed";
export function segmentsToPath(segments: unknown): string | null;
