"use client";
import {
  createContext, useContext, useState, useEffect, useCallback, type ReactNode,
} from "react";
import type { Office } from "@/types/domain";
import type { DemoSession, DemoPreferences, AcceptInviteReason, CreateOfficeReason } from "@/lib/session.d.mts";
import {
  defaultSession, isValidSession,
  applySignUp, applySignIn, applyAutonomo, applyCreateOffice, applyAcceptInvite,
  canAcceptInvite, canCreateOffice, resetSession, applyLeaveOffice,
  applyUpdateProfile, applyUpdatePreferences,
} from "@/lib/session.mjs";

const STORAGE_KEY = "prazoai:demo-session";

interface SessionApi {
  session: DemoSession;
  hydrated: boolean;
  signUp: (data: { name: string; email: string }) => void;
  signIn: (data: { name?: string; email: string }) => void;
  completeAutonomo: (preferences?: DemoPreferences) => void;
  createOffice: (data: { name: string; role?: string; area?: string }) => { ok: boolean; reason?: CreateOfficeReason };
  canCreate: () => { ok: boolean; reason?: CreateOfficeReason };
  acceptInvite: (office: Office) => void;
  canAccept: (inviteOfficeId: string) => { ok: boolean; reason?: AcceptInviteReason };
  reset: () => void;
  clearOffice: () => void;
  updateProfile: (data: { name?: string }) => void;
  updatePreferences: (preferences: DemoPreferences) => void;
}

const SessionContext = createContext<SessionApi | null>(null);

function loadStored(): DemoSession | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return isValidSession(parsed) ? (parsed as DemoSession) : null;
  } catch {
    return null;
  }
}

export function SessionProvider({ children }: { children: ReactNode }) {
  // Início estável para SSR/primeira pintura (evita divergência de hidratação):
  // sempre a sessão padrão. A sessão salva é aplicada após montar.
  const [session, setSession] = useState<DemoSession>(() => defaultSession());
  const [hydrated, setHydrated] = useState(false);

  // Hidrata a partir do localStorage (somente cliente). Só habilita a escrita
  // após a leitura terminar, para não gravar o estado vazio por cima do salvo.
  useEffect(() => {
    const stored = loadStored();
    if (stored) setSession(stored);
    setHydrated(true);
  }, []);

  // Persiste mudanças (nunca há senha na sessão), apenas depois de hidratar.
  useEffect(() => {
    if (!hydrated) return;
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(session)); } catch { /* ignora */ }
  }, [session, hydrated]);

  const signUp = useCallback((data: { name: string; email: string }) => setSession((s) => applySignUp(s, data)), []);
  const signIn = useCallback((data: { name?: string; email: string }) => setSession((s) => applySignIn(s, data)), []);
  const completeAutonomo = useCallback((preferences?: DemoPreferences) => setSession((s) => applyAutonomo(s, preferences)), []);
  const createOffice = useCallback((data: { name: string; role?: string; area?: string }) => {
    // Bloqueia criação com vínculo ativo — nunca substitui em silêncio.
    const check = canCreateOffice(session);
    if (!check.ok) return check;
    setSession((s) => (s.office ? s : applyCreateOffice(s, data)));
    return { ok: true as const };
  }, [session]);
  const canCreate = useCallback(() => canCreateOffice(session), [session]);
  const acceptInvite = useCallback((office: Office) => setSession((s) => applyAcceptInvite(s, office)), []);
  const canAccept = useCallback((inviteOfficeId: string) => canAcceptInvite(session, inviteOfficeId), [session]);
  const reset = useCallback(() => setSession(resetSession()), []);
  const clearOffice = useCallback(() => setSession((s) => applyLeaveOffice(s)), []);
  const updateProfile = useCallback((data: { name?: string }) => setSession((s) => applyUpdateProfile(s, data)), []);
  const updatePreferences = useCallback((preferences: DemoPreferences) => setSession((s) => applyUpdatePreferences(s, preferences)), []);

  const value: SessionApi = {
    session, hydrated,
    signUp, signIn, completeAutonomo, createOffice, canCreate, acceptInvite, canAccept, reset, clearOffice, updateProfile, updatePreferences,
  };

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionApi {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error("useSession deve ser usado dentro de <SessionProvider>");
  return ctx;
}
