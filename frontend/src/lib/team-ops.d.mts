import type { Deadline } from "@/types/domain";
import type { OrgState } from "@/lib/org-ops.d.mts";
import type { DataState, OpDeps, Seeds } from "@/lib/data-ops.d.mts";

export function openOfficeDeadlinesFor(dataState: DataState, seeds: Seeds, officeId: string, userId: string): Deadline[];
export function coordinateRemoveMember(
  org: OrgState,
  data: DataState,
  actorId: string,
  params: { officeId: string; userId: string; reassignTo: string | undefined },
  deps: OpDeps,
  seeds: Seeds
): { org: OrgState; data: DataState; ok: boolean; reason: string | null };
