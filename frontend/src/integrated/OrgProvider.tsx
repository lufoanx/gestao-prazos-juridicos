"use client";
// Vínculo e ambiente do MODO INTEGRADO (6.2). Fonte única: o servidor (GET /memberships/me).
// A seleção de ambiente é contexto de navegação, nunca autorização.
import { createContext, useContext, useEffect, useMemo, useSyncExternalStore, type ReactNode } from "react";
import { createOrgClient, type OrgClient } from "@/lib/integration/org-client.mjs";
import { createOrgController, type OrgController, type OrgState } from "@/lib/integration/org-controller.mjs";
import { createQueryCache, type QueryCache } from "@/lib/integration/query-cache.mjs";
import { useAuth } from "./AuthProvider";

// Preferência de NAVEGAÇÃO por aba e por usuário (não sensível, não é autorização).
const sessionScopeStore = {
  get(userId: string) {
    try {
      const v = sessionStorage.getItem(`prazoai:integrated:scope:${userId}`);
      return v === "personal" || v === "office" ? v : null;
    } catch { return null; }
  },
  set(userId: string, scope: "personal" | "office") {
    try { sessionStorage.setItem(`prazoai:integrated:scope:${userId}`, scope); } catch { /* sem storage */ }
  },
};

interface OrgApi { org: OrgClient; controller: OrgController; cache: QueryCache; state: OrgState }
const OrgContext = createContext<OrgApi | null>(null);
const SERVER_STATE: OrgState = { status: "idle", userId: null, office: null, membership: null, scope: "personal", error: null };

export function OrgProvider({ children }: { children: ReactNode }) {
  const { api, state: auth } = useAuth();
  const value = useMemo(() => {
    const org = createOrgClient(api);
    const cache = createQueryCache();
    const channel = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel("prazoai-org") : null;
    const controller = createOrgController({ org, api, channel, onReset: () => cache.clear(), scopeStore: sessionScopeStore });
    return { org, cache, controller };
  }, [api]);
  const state = useSyncExternalStore((cb) => value.controller.subscribe(cb), () => value.controller.state, () => SERVER_STATE);

  const userId = auth.status === "authenticated" ? auth.user?.id ?? null : null;
  useEffect(() => {
    // Troca de usuário/saída: descarta tudo e recarrega do servidor.
    value.controller.reset(userId);
    if (userId) void value.controller.refresh({ userId }).catch(() => {});
  }, [userId, value]);

  useEffect(() => {
    if (!userId) return;
    const onFocus = () => { void value.controller.revalidate(); };
    const onVisible = () => { if (document.visibilityState === "visible") onFocus(); };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisible);
    return () => { window.removeEventListener("focus", onFocus); document.removeEventListener("visibilitychange", onVisible); };
  }, [userId, value]);

  return <OrgContext.Provider value={{ ...value, state }}>{children}</OrgContext.Provider>;
}

export function useOrg(): OrgApi {
  const ctx = useContext(OrgContext);
  if (!ctx) throw new Error("useOrg fora do OrgProvider (modo integrado)");
  return ctx;
}
