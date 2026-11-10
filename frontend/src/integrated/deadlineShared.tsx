"use client";
// Contexto comum das telas de prazos (6.3): cliente, ambiente, capacidades e nomes autorizados.
import { useCallback, useMemo } from "react";
import { cacheKey } from "@/lib/integration/query-cache.mjs";
import { Badge } from "@/components/ui";
import { createDeadlinesClient } from "@/lib/integration/deadlines-client.mjs";
import { deadlineCaps, displayName } from "@/lib/integration/deadline-caps.mjs";
import type { Deadline, MembersResponse } from "@/lib/integration/dto.d.mts";
import { useAuth } from "./AuthProvider";
import { useOrg } from "./OrgProvider";
import { useResource } from "./useResource";

export const STATUS_LABEL = { open: "Em aberto", completed: "Concluído", cancelled: "Cancelado" } as const;
export const STATUS_TONE = { open: "info", completed: "success", cancelled: "neutral" } as const;
export const URGENCY_LABEL = { overdue: "Vencido", today: "Vence hoje", soon: "Próximo", upcoming: "Futuro" } as const;
export const URGENCY_TONE = { overdue: "danger", today: "warning", soon: "warning", upcoming: "neutral" } as const;

export function useDeadlineContext() {
  const { api, state: auth } = useAuth();
  const { state: org, org: orgClient } = useOrg();
  const client = useMemo(() => createDeadlinesClient(api), [api]);
  const scope = org.scope;
  const me = auth.user ? { id: auth.user.id, name: auth.user.name } : null;
  const caps = deadlineCaps(scope, org.membership);
  const officeId = scope === "office" ? org.office?.id ?? null : null;
  // Nomes vêm da projeção AUTORIZADA da equipe (pública basta); nunca de e-mails administrativos.
  const members = useResource<MembersResponse>(officeId ? "members" : null, () => orgClient.members(officeId!));
  const names = useMemo(() => {
    const map = new Map<string, string>();
    if (members.status === "ready") for (const m of members.data.members) map.set(m.userId, m.name);
    return map;
  }, [members]);
  const nameOf = (userId: string | null | undefined) => displayName(userId, names, me);
  return { client, scope, caps, me, officeId, org, members, names, nameOf };
}

/** Após mutações: invalida listas, calendário e o prazo (mesma chave de usuário/escritório/ambiente/revisão). */
export function useInvalidateDeadlines() {
  const { cache, state } = useOrg();
  return useCallback((deadlineId?: string) => {
    if (!state.userId) return;
    const base = { userId: state.userId, officeId: state.office?.id ?? null, scope: state.scope, revision: state.revision };
    for (const r of ["deadlines", "calendar", ...(deadlineId ? [`deadline:${deadlineId}`] : [])]) cache.invalidate(cacheKey(base, r));
  }, [cache, state]);
}

export function UrgencyBadge({ d }: { d: Deadline }) {
  if (!d.urgency) return <span className="text-muted">—</span>;
  const days = d.urgency.days;
  const label = URGENCY_LABEL[d.urgency.level];
  const detail = d.urgency.level === "overdue" ? ` (${-days} dia(s))` : d.urgency.level === "soon" ? ` (${days} dia(s))` : "";
  return <Badge tone={URGENCY_TONE[d.urgency.level]} dot>{label}{detail}</Badge>;
}

export function ScopeGate({ children }: { children: React.ReactNode }) {
  const { org, caps, scope } = useDeadlineContext();
  if (org.status !== "ready") return <p aria-busy="true">Carregando…</p>;
  if (scope === "office" && !caps.canRead) {
    return <p role="status" className="text-muted">Você não tem a permissão “Ver prazos” neste escritório. Seus prazos pessoais continuam no ambiente pessoal.</p>;
  }
  return <>{children}</>;
}
