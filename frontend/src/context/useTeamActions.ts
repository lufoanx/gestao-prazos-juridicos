"use client";
import { useCallback } from "react";
import { useOrg } from "@/context/OrgContext";
import { useData } from "@/context/DataContext";
import { useSession } from "@/context/SessionContext";
import { getDemoToday } from "@/lib/clock.mjs";
import { newId } from "@/lib/ids.mjs";
import {
  demoDeadlines, demoAttachments, demoIntimations, demoNotifications, DEMO_USER_ID,
} from "@/mocks/data";
import { coordinateRemoveMember, openOfficeDeadlinesFor } from "@/lib/team-ops.mjs";
import type { OrgState } from "@/lib/org-ops.d.mts";
import type { DataState } from "@/lib/data-ops.d.mts";

/**
 * Ações de equipe que precisam coordenar DOIS estados (roster + prazos).
 * A remoção de membro é validada pela operação pura coordenada (permissão,
 * último admin, prazos em aberto, destinatário ativo). Só se ok, aplica
 * reatribuição e remoção via reducers centralizados. Em falha, nada muda.
 */
export function useTeamActions() {
  const org = useOrg();
  const data = useData();
  const { session } = useSession();
  const actorId = session.user?.id ?? DEMO_USER_ID;
  const today = getDemoToday();

  const removeMember = useCallback(
    (officeId: string, userId: string, reassignTo: string | undefined): { ok: boolean; reason: string | null } => {
      const deps = { newId, today };
      const seeds = { deadlines: demoDeadlines, attachments: demoAttachments, intimations: demoIntimations, notifications: demoNotifications };
      const orgSnap = {
        offices: org.offices, memberships: org.memberships, invites: org.invites, joinRequests: org.joinRequests, leftKeys: [],
      } as OrgState;
      const dataSnap = { deadlines: data.deadlines } as unknown as DataState;

      // Operação coordenada (pura) decide tudo num só lugar.
      const res = coordinateRemoveMember(orgSnap, dataSnap, actorId, { officeId, userId, reassignTo }, deps, seeds);
      if (!res.ok) return { ok: false, reason: res.reason };

      // Comita ambas as mudanças (reducers centralizados) somente após validar.
      const open = openOfficeDeadlinesFor(dataSnap, seeds, officeId, userId);
      if (open.length > 0) data.reassignOpenDeadlines(officeId, userId, reassignTo!);
      org.removeMember(officeId, userId);
      return { ok: true, reason: null };
    },
    [org, data, actorId, today]
  );

  return { removeMember };
}
