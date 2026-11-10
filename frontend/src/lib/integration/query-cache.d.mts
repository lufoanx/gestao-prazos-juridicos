export function cacheKey(ctx: { userId: string | null; officeId: string | null; scope: string; revision?: number }, resource: string): string;
export interface QueryCache { get(k: string): unknown; set(k: string, v: unknown): void; invalidate(prefix: string): void; clear(): void; readonly size: number }
export function createQueryCache(opts?: { maxEntries?: number }): QueryCache;
