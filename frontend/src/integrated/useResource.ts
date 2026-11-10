"use client";
// Recurso do servidor com cache por usuário + escritório + ambiente; estados distintos.
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, StaleResponseError } from "@/lib/integration/api-client.mjs";
import { cacheKey } from "@/lib/integration/query-cache.mjs";
import { useAuth } from "./AuthProvider";
import { useOrg } from "./OrgProvider";
import { errorMessage } from "./messages";

export type Resource<T> =
  | { status: "loading" }
  | { status: "ready"; data: T }
  | { status: "forbidden"; message: string }
  | { status: "error"; message: string; unavailable: boolean }
  /** Resposta válida, mas incompatível com o contexto atual (ex.: prazo de outro ambiente). Não é cacheada. */
  | { status: "mismatch"; data: T };

/** Trata 401 (sessão), 403/404 (revalida vínculo, sem logout). Retorna true se tratado. */
export function useApiErrorHandler() {
  const { controller: auth } = useAuth();
  const { controller: org } = useOrg();
  return useCallback((e: unknown): boolean => {
    if (e instanceof StaleResponseError) return true;
    if (e instanceof ApiError && e.status === 401) { auth.sessionEnded(e.code); return true; }
    if (e instanceof ApiError && (e.status === 403 || e.status === 404)) void org.revalidate();
    return false;
  }, [auth, org]);
}

export function useResource<T>(
  resource: string | null, fetcher: () => Promise<T>, opts: { accept?: (data: T) => boolean } = {},
): Resource<T> & { reload: () => void } {
  const { cache, state } = useOrg();
  const handle = useApiErrorHandler();
  const key = resource && state.userId
    ? cacheKey({ userId: state.userId, officeId: state.office?.id ?? null, scope: state.scope, revision: state.revision }, resource)
    : null;
  // Chave ATUAL: uma resposta só é aplicada/cacheada se ainda pertence à chave (e revisão) vigente.
  const currentKey = useRef(key);
  currentKey.current = key;
  // O estado guarda a chave a que pertence: dados de outra chave/revisão NUNCA são devolvidos,
  // nem no render intermediário antes do efeito.
  const [entry, setEntry] = useState<{ key: string | null; res: Resource<T> }>(() => {
    const hit = key ? cache.get(key) : undefined;
    return { key, res: hit !== undefined ? { status: "ready", data: hit as T } : { status: "loading" } };
  });
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!key) return;
    let alive = true;
    const hit = cache.get(key);
    // Mesma chave (recarga após mutação): mantém os dados atuais enquanto atualiza. Chave nova
    // (outro usuário/escritório/ambiente/revisão/filtro): nada da anterior é mostrado.
    setEntry((prev) => (hit !== undefined
      ? { key, res: { status: "ready", data: hit as T } }
      : prev.key === key && prev.res.status === "ready" ? prev : { key, res: { status: "loading" } }));
    fetcher()
      .then((data) => {
        if (!alive || currentKey.current !== key) return;           // resposta de outra revisão/chave
        if (opts.accept && !opts.accept(data)) {                    // incompatível: nunca vai ao cache
          cache.invalidate(key);
          setEntry({ key, res: { status: "mismatch", data } });
          return;
        }
        cache.set(key, data);
        setEntry({ key, res: { status: "ready", data } });
      })
      .catch((e) => {
        if (!alive || currentKey.current !== key || handle(e)) return;
        if (e instanceof ApiError && (e.status === 403 || e.status === 404)) {
          cache.invalidate(key);
          setEntry({ key, res: { status: "forbidden", message: "Você não tem acesso a esta área ou ela não existe mais." } });
          return;
        }
        setEntry({ key, res: { status: "error", message: errorMessage(e), unavailable: e instanceof ApiError && ["unavailable", "network"].includes(e.category) } });
      });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, tick]);

  const res: Resource<T> = entry.key === key ? entry.res : (() => {
    const hit = key ? cache.get(key) : undefined;
    return hit !== undefined ? { status: "ready", data: hit as T } : { status: "loading" };
  })();
  const reload = useCallback(() => { if (key) cache.invalidate(key); setTick((t) => t + 1); }, [cache, key]);
  return Object.assign({}, res, { reload });
}
