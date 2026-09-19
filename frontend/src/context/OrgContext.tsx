"use client";
import {
  createContext, useContext, useState, useEffect, useMemo, useCallback, type ReactNode,
} from "react";
import type { Office, Membership, Invitation, JoinRequest, User } from "@/types/domain";
import { demoOffice, demoMemberships, demoInvites, demoJoinRequests } from "@/mocks/data";
import { useSession } from "@/context/SessionContext";
import { getDemoToday } from "@/lib/clock.mjs";
import { newId } from "@/lib/ids.mjs";
import { addDays } from "@/lib/dates.mjs";
import {
  opUpdateOffice, opSetMemberProfile, opSetMemberPermissions, opRemoveMember, opTransferAdmin,
  opCreateInvite, opRevokeInvite, opAcceptInvite, opRequestJoin,
  opApproveRequest, opRejectRequest, membershipOf, officeOfUser, validateRemoveMember, opLeaveOrTransferOffice,
} from "@/lib/org-ops.mjs";
import type { OrgState } from "@/lib/org-ops.d.mts";

const STORAGE_KEY = "prazoai:demo-org:v1";
const ORG_VERSION = 1;

interface Persisted extends OrgState { version: number; }

function seededState(): OrgState {
  return {
    offices: [demoOffice],
    memberships: demoMemberships.map((m) => ({ ...m })),
    invites: [...demoInvites],
    joinRequests: [...demoJoinRequests],
    leftKeys: [],
  };
}

function loadStored(): OrgState | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as Persisted;
    // Migração: versão futura/ inválida → fallback; igual/anterior → preserva o roster.
    if (!p || typeof p.version !== "number" || p.version > ORG_VERSION || !Array.isArray(p.offices)) return null;
    return {
      offices: p.offices, memberships: p.memberships || [], invites: p.invites || [], joinRequests: p.joinRequests || [],
      leftKeys: p.leftKeys || [],
    };
  } catch { return null; }
}

interface OrgApi {
  offices: Office[];
  memberships: Membership[];
  invites: Invitation[];
  joinRequests: JoinRequest[];
  /** Vínculo efetivo do usuário atual (roster compartilhado), se houver. */
  myMembership: Membership | undefined;
  /** Vínculo do usuário em QUALQUER escritório do roster (para regra de escritório único). */
  myOfficeMembership: Membership | undefined;
  updateOffice: (officeId: string, patch: { name?: string }) => void;
  setMemberProfile: (officeId: string, userId: string, patch: { roleLabel?: string; practiceAreas?: string[]; visibility?: "all" | "assigned" }) => void;
  setMemberPermissions: (officeId: string, userId: string, permissions: Membership["permissions"]) => void;
  removeMember: (officeId: string, userId: string) => void;
  validateRemove: (officeId: string, userId: string, openCount: number, reassignTo: string | undefined) => { ok: boolean; reason: string | null };
  transferAdmin: (officeId: string, userId: string) => void;
  leaveOffice: (officeId: string, transferTo?: string) => { ok: boolean; reason: string | null };
  createInvite: (officeId: string, roleLabel?: string) => Invitation | null;
  revokeInvite: (inviteId: string) => void;
  acceptInvite: (token: string, actor: User) => { officeId: string | null; reason: string | null; membership?: Membership };
  requestJoin: (officeId: string, actor: User) => { id: string | null; reason: string | null };
  approveRequest: (requestId: string) => { reason: string | null };
  rejectRequest: (requestId: string) => void;
}

const OrgContext = createContext<OrgApi | null>(null);

export function OrgProvider({ children }: { children: ReactNode }) {
  const { session, clearOffice } = useSession();
  const [state, setState] = useState<OrgState>(() => seededState());
  const [hydrated, setHydrated] = useState(false);
  const today = getDemoToday();
  const deps = useMemo(() => ({ newId, today, addDays }), [today]);
  const uid = session.user?.id;
  const ctx = useMemo(() => ({ userId: uid ?? "" }), [uid]);

  // Hidrata do localStorage; só grava após ler (não sobrescreve com vazio).
  useEffect(() => {
    const stored = loadStored();
    if (stored) setState(stored);
    setHydrated(true);
  }, []);
  useEffect(() => {
    if (!hydrated) return;
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: ORG_VERSION, ...state })); } catch { /* ignora */ }
  }, [state, hydrated]);

  // Reconciliação com a sessão: o escritório criado/entrado passa a existir no
  // roster compartilhado (persistindo além da sessão). NÃO ressuscita vínculos
  // encerrados (tombstones em leftKeys).
  useEffect(() => {
    if (!hydrated) return;
    const office = session.office;
    const membership = session.membership;
    if (!office) return;
    setState((s) => {
      const tomb = new Set(s.leftKeys || []);
      let next = s;
      if (!s.offices.some((o) => o.id === office.id)) next = { ...next, offices: [...next.offices, office] };
      if (membership
        && !tomb.has(`${membership.userId}::${membership.officeId}`)
        && !next.memberships.some((m) => m.officeId === membership.officeId && m.userId === membership.userId)) {
        next = { ...next, memberships: [...next.memberships, membership] };
      }
      return next === s ? s : next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated, session.office?.id, session.membership?.userId, state.leftKeys]);

  const myMembership = useMemo(
    () => (uid ? membershipOf(state, session.office?.id ?? "", uid) : undefined),
    [state, uid, session.office?.id]
  );
  const myOfficeMembership = useMemo(
    () => (uid ? officeOfUser(state, uid) : undefined),
    [state, uid]
  );

  const updateOffice = useCallback((officeId: string, patch: { name?: string }) => setState((s) => opUpdateOffice(s, ctx, officeId, patch)), [ctx]);
  const setMemberProfile = useCallback((officeId: string, userId: string, patch: { roleLabel?: string; practiceAreas?: string[]; visibility?: "all" | "assigned" }) => setState((s) => opSetMemberProfile(s, ctx, officeId, userId, patch)), [ctx]);
  const setMemberPermissions = useCallback((officeId: string, userId: string, permissions: Membership["permissions"]) => setState((s) => opSetMemberPermissions(s, ctx, officeId, userId, permissions)), [ctx]);
  const removeMember = useCallback((officeId: string, userId: string) => setState((s) => opRemoveMember(s, ctx, officeId, userId)), [ctx]);
  const validateRemove = useCallback(
    (officeId: string, userId: string, openCount: number, reassignTo: string | undefined) =>
      validateRemoveMember(state, officeId, ctx.userId, userId, openCount, reassignTo),
    [state, ctx]
  );
  const transferAdmin = useCallback((officeId: string, userId: string) => setState((s) => opTransferAdmin(s, ctx, officeId, userId)), [ctx]);
  const leaveOffice = useCallback((officeId: string, transferTo?: string): { ok: boolean; reason: string | null } => {
    const res = opLeaveOrTransferOffice(state, ctx, officeId, transferTo);
    if (!res.ok) return { ok: false, reason: res.reason }; // preserva sessão e vínculo
    setState(res.state);
    // Fonte única: encerra o vínculo também na sessão SOMENTE quando a saída concluiu.
    if (session.office?.id === officeId) clearOffice();
    return { ok: true, reason: null };
  }, [state, ctx, session.office?.id, clearOffice]);

  const createInvite = useCallback((officeId: string, roleLabel?: string) => {
    const res = opCreateInvite(state, ctx, officeId, deps, roleLabel);
    setState(res.state);
    return res.invite;
  }, [state, ctx, deps]);
  const revokeInvite = useCallback((inviteId: string) => setState((s) => opRevokeInvite(s, ctx, inviteId)), [ctx]);
  const acceptInvite = useCallback((token: string, actor: User) => {
    const res = opAcceptInvite(state, actor, token, deps);
    setState(res.state);
    return { officeId: res.officeId, reason: res.reason, membership: res.membership };
  }, [state, deps]);
  const requestJoin = useCallback((officeId: string, actor: User) => {
    const res = opRequestJoin(state, actor, officeId, deps);
    setState(res.state);
    return { id: res.id, reason: res.reason };
  }, [state, deps]);
  const approveRequest = useCallback((requestId: string) => {
    const res = opApproveRequest(state, ctx, requestId);
    setState(res.state);
    return { reason: res.reason };
  }, [state, ctx]);
  const rejectRequest = useCallback((requestId: string) => setState((s) => opRejectRequest(s, ctx, requestId)), [ctx]);

  const value: OrgApi = {
    offices: state.offices, memberships: state.memberships, invites: state.invites, joinRequests: state.joinRequests,
    myMembership, myOfficeMembership,
    updateOffice, setMemberProfile, setMemberPermissions, removeMember, validateRemove, transferAdmin, leaveOffice,
    createInvite, revokeInvite, acceptInvite, requestJoin, approveRequest, rejectRequest,
  };
  return <OrgContext.Provider value={value}>{children}</OrgContext.Provider>;
}

export function useOrg(): OrgApi {
  const ctx = useContext(OrgContext);
  if (!ctx) throw new Error("useOrg deve ser usado dentro de <OrgProvider>");
  return ctx;
}
