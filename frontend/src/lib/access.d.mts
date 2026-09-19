import type { Membership, Deadline } from "@/types/domain";
export function canReadDeadline(userId: string, membership: Membership | null, deadline: Pick<Deadline, "scope" | "responsibleId">): boolean;
export function canJoinOffice(membership: Membership | null): boolean;
export function canManageDeadline(scopeKind: "personal" | "office", membership: import("@/types/domain").Membership | null, perm: import("@/types/domain").Permission): boolean;
