// Cache pequeno do modo integrado. Chaves SEMPRE incluem usuário, escritório e ambiente:
// dados de outro usuário/escritório nunca são servidos; invalidação por prefixo após mutações.

export function cacheKey({ userId, officeId, scope, revision = 0 }, resource) {
  if (!userId) throw new Error("cache exige usuário");
  // A revisão de autorização faz parte da chave: dados de outra revisão nunca são servidos.
  return `u:${userId}|o:${officeId ?? "-"}|s:${scope}|r:${revision}|${resource}`;
}

export function createQueryCache({ maxEntries = 100 } = {}) {
  const entries = new Map();
  const inflight = new Map();          // chave → promessa em andamento (removida ao terminar)
  return {
    /**
     * Reaproveita a requisição em andamento para a MESMA chave (componentes que mostram o mesmo
     * recurso não duplicam chamadas). Só para leituras; mutações nunca passam por aqui.
     */
    dedupe(key, fetcher) {
      if (inflight.has(key)) return inflight.get(key);
      const p = Promise.resolve().then(fetcher).finally(() => { if (inflight.get(key) === p) inflight.delete(key); });
      inflight.set(key, p);
      return p;
    },
    get inflightSize() { return inflight.size; },
    get(key) { return entries.has(key) ? entries.get(key) : undefined; },
    set(key, value) {
      entries.delete(key);
      entries.set(key, value);
      while (entries.size > maxEntries) entries.delete(entries.keys().next().value);
    },
    invalidate(prefix) { for (const k of [...entries.keys()]) if (k.startsWith(prefix)) entries.delete(k); },
    clear() { entries.clear(); inflight.clear(); },
    get size() { return entries.size; },
  };
}
