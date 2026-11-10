"use client";
// Recurso do servidor com cache por usuário + escritório + ambiente; estados distintos.
import { useCallback, useEffect, useState } from "react";
import { ApiError, StaleResponseError } from "@/lib/integration/api-client.mjs";
import { cacheKey } from "@/lib/integration/query-cache.mjs";
import { useAuth } from "./AuthProvider";
import { useOrg } from "./OrgProvider";
import { errorMessage } from "./messages";

export type Resource<T> =
  | { status: "loading" }
  | { status: "ready"; data: T }
  | { status: "forbidden"; message: string }
  | { status: "error"; message: string; unavailable: boolean };

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

export function useResource<T>(resource: string | null, fetcher: () => Promise<T>): Resource<T> & { reload: () => void } {
  const { cache, state } = useOrg();
  const handle = useApiErrorHandler();
  const key = resource && state.userId ? cacheKey({ userId: state.userId, officeId: state.office?.id ?? null, scope: state.scope }, resource) : null;
  const [res, setRes] = useState<Resource<T>>(() => {
    const hit = key ? cache.get(key) : undefined;
    return hit !== undefined ? { status: "ready", data: hit as T } : { status: "loading" };
  });
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!key) return;
    let alive = true;
    const hit = cache.get(key);
    setRes(hit !== undefined ? { status: "ready", data: hit as T } : { status: "loading" });
    fetcher()
      .then((data) => { if (alive) { cache.set(key, data); setRes({ status: "ready", data }); } })
      .catch((e) => {
        if (!alive || handle(e)) return;
        if (e instanceof ApiError && (e.status === 403 || e.status === 404)) {
          cache.invalidate(key);
          setRes({ status: "forbidden", message: "Você não tem acesso a esta área ou ela não existe mais." });
          return;
        }
        setRes({ status: "error", message: errorMessage(e), unavailable: e instanceof ApiError && ["unavailable", "network"].includes(e.category) });
      });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, tick]);

  const reload = useCallback(() => { if (key) cache.invalidate(key); setTick((t) => t + 1); }, [cache, key]);
  return Object.assign({}, res, { reload });
}
