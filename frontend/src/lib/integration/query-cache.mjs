// Cache pequeno do modo integrado. Chaves SEMPRE incluem usuário, escritório e ambiente:
// dados de outro usuário/escritório nunca são servidos; invalidação por prefixo após mutações.

export function cacheKey({ userId, officeId, scope }, resource) {
  if (!userId) throw new Error("cache exige usuário");
  return `u:${userId}|o:${officeId ?? "-"}|s:${scope}|${resource}`;
}

export function createQueryCache({ maxEntries = 100 } = {}) {
  const entries = new Map();
  return {
    get(key) { return entries.has(key) ? entries.get(key) : undefined; },
    set(key, value) {
      entries.delete(key);
      entries.set(key, value);
      while (entries.size > maxEntries) entries.delete(entries.keys().next().value);
    },
    invalidate(prefix) { for (const k of [...entries.keys()]) if (k.startsWith(prefix)) entries.delete(k); },
    clear() { entries.clear(); },
    get size() { return entries.size; },
  };
}
