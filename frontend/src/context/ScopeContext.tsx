"use client";
import { createContext, useContext, useMemo, useState, useEffect, useCallback, type ReactNode } from "react";
import type { Scope, User, Membership, Office } from "@/types/domain";
import { demoUsers, demoMembership, demoOffice, DEMO_USER_ID } from "@/mocks/data";
import { useSession } from "@/context/SessionContext";
import { useOrg } from "@/context/OrgContext";
import { defaultScopeKind } from "@/lib/session.mjs";

export type ScopeKind = "personal" | "office";

interface ScopeContextValue {
  user: User;
  office: Office | null;
  membership: Membership | null;
  scopeKind: ScopeKind;
  scope: Scope;
  hasOffice: boolean;
  setScopeKind: (k: ScopeKind) => void;
}

const ScopeContext = createContext<ScopeContextValue | null>(null);

export function ScopeProvider({ children }: { children: ReactNode }) {
  const { session } = useSession();

  // Persona semeada (Paula/u1) usada apenas na visita DIRETA ao dashboard,
  // quando ainda não há sessão iniciada — assim o dashboard aprovado continua
  // populado. Com sessão iniciada (cadastro/login/onboarding/convite), tudo
  // reflete os dados da pessoa.
  const seededUser = useMemo(() => demoUsers.find((u) => u.id === DEMO_USER_ID)!, []);
  const started = !!(session.user || session.office || session.profile);

  const user: User = session.user ?? seededUser;
  const { memberships, offices } = useOrg();
  // Vínculo EFETIVO vem do roster compartilhado (permissões/cargo/visibilidade
  // mudam imediatamente; escritório persiste além da sessão). Fallback: sessão/semente.
  const rosterMembership: Membership | null = useMemo(
    () => memberships.find((m) => m.userId === user.id) ?? null,
    [memberships, user.id]
  );
  const officeFromRoster: Office | null = useMemo(
    () => (rosterMembership ? offices.find((o) => o.id === rosterMembership.officeId) ?? null : null),
    [rosterMembership, offices]
  );
  // Fonte da verdade: o roster compartilhado. Assim, criar/entrar/sair/ser removido
  // refletem imediatamente e o escritório persiste além da sessão. Visita direta
  // (sem sessão) usa a persona semeada.
  const office: Office | null = started ? officeFromRoster : demoOffice;
  const membership: Membership | null = started ? rosterMembership : demoMembership;
  const hasOffice = office != null;

  const [scopeKind, setScopeKindState] = useState<ScopeKind>("personal");
  const setScopeKind = useCallback((k: ScopeKind) => setScopeKindState(k), []);

  // Ambiente inicial derivado do perfil (autônomo → pessoal; escritório → escritório).
  // Roda quando a sessão muda (hidratação / ações), não a cada render.
  useEffect(() => {
    setScopeKindState(defaultScopeKind(session));
  }, [session]);

  const effectiveKind: ScopeKind = scopeKind === "office" && hasOffice ? "office" : "personal";

  const scope: Scope = useMemo(
    () => (effectiveKind === "office" && office
      ? { kind: "office", officeId: office.id }
      : { kind: "personal", ownerId: user.id }),
    [effectiveKind, office, user.id]
  );

  const value: ScopeContextValue = {
    user, office, membership,
    scopeKind: effectiveKind, scope,
    hasOffice,
    setScopeKind,
  };

  return <ScopeContext.Provider value={value}>{children}</ScopeContext.Provider>;
}

export function useScope() {
  const ctx = useContext(ScopeContext);
  if (!ctx) throw new Error("useScope deve ser usado dentro de <ScopeProvider>");
  return ctx;
}
