"use client";
// Provedor de autenticação do MODO INTEGRADO (Etapa 6.1). Não lê nenhuma chave demonstrativa.
import { createContext, useContext, useEffect, useMemo, useSyncExternalStore, type ReactNode } from "react";
import { createApiClient, type ApiClient } from "@/lib/integration/api-client.mjs";
import { createAuthController, type AuthController, type AuthState } from "@/lib/integration/auth-controller.mjs";

interface AuthApi { controller: AuthController; api: ApiClient; state: AuthState }

const AuthContext = createContext<AuthApi | null>(null);
const SERVER_STATE: AuthState = { status: "loading", user: null, error: null };

export function AuthProvider({ children }: { children: ReactNode }) {
  const value = useMemo(() => {
    const api = createApiClient();
    const channel = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel("prazoai-auth") : null;
    const controller = createAuthController({ api, channel });
    return { api, controller };
  }, []);
  const state = useSyncExternalStore(
    (cb) => value.controller.subscribe(cb),
    () => value.controller.state,
    () => SERVER_STATE,
  );
  useEffect(() => { void value.controller.restore(); }, [value]);
  return <AuthContext.Provider value={{ ...value, state }}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthApi {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth fora do AuthProvider (modo integrado)");
  return ctx;
}
