"use client";
import { createContext, useContext, useState, useEffect, useMemo, useCallback, type ReactNode } from "react";
import { useSession } from "@/context/SessionContext";
import { DEMO_USER_ID } from "@/mocks/data";
import { defaultSettings, sanitizeSettings, mergeSettings, SETTINGS_VERSION } from "@/lib/settings.mjs";
import type { DemoSettings } from "@/lib/settings.d.mts";

const STORAGE_KEY = "prazoai:demo-settings:v1";

type Store = { version: number; byUser: Record<string, DemoSettings> };

function loadStore(): Store {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { version: SETTINGS_VERSION, byUser: {} };
    const p = JSON.parse(raw);
    // Migração: versão futura/ inválida → padrão; igual/anterior → preserva as prefs.
    if (!p || typeof p.version !== "number" || p.version > SETTINGS_VERSION || typeof p.byUser !== "object") return { version: SETTINGS_VERSION, byUser: {} };
    return { version: SETTINGS_VERSION, byUser: p.byUser } as Store;
  } catch { return { version: SETTINGS_VERSION, byUser: {} }; }
}

interface SettingsApi {
  settings: DemoSettings;
  update: (patch: Partial<DemoSettings>) => void;
  reset: () => void;
}
const SettingsContext = createContext<SettingsApi | null>(null);

export function SettingsProvider({ children }: { children: ReactNode }) {
  const { session } = useSession();
  const userId = session.user?.id ?? DEMO_USER_ID;
  const [store, setStore] = useState<Store>({ version: SETTINGS_VERSION, byUser: {} });
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => { setStore(loadStore()); setHydrated(true); }, []);
  useEffect(() => {
    if (!hydrated) return;
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(store)); } catch { /* ignora */ }
  }, [store, hydrated]);

  // Preferências do usuário atual (isoladas por conta).
  const settings = useMemo(() => sanitizeSettings(store.byUser[userId]), [store, userId]);

  const update = useCallback((patch: Partial<DemoSettings>) => {
    setStore((s) => ({ ...s, byUser: { ...s.byUser, [userId]: mergeSettings(sanitizeSettings(s.byUser[userId]), patch) } }));
  }, [userId]);
  const reset = useCallback(() => {
    setStore((s) => ({ ...s, byUser: { ...s.byUser, [userId]: defaultSettings() } }));
  }, [userId]);

  return <SettingsContext.Provider value={{ settings, update, reset }}>{children}</SettingsContext.Provider>;
}

export function useSettings(): SettingsApi {
  const ctx = useContext(SettingsContext);
  if (!ctx) throw new Error("useSettings deve ser usado dentro de <SettingsProvider>");
  return ctx;
}
