import type { Deadline, Scope, Membership, Permission } from "@/types/domain";

export type DeadlineOp =
  | "create" | "edit" | "complete" | "cancel" | "reopen"
  | "comment" | "attach" | "removeAttachment";

export interface WriteContext {
  scope: Scope;
  scopeKind: "personal" | "office";
  userId: string;
  membership: Membership | null;
}

export const OP_PERMISSION: Record<DeadlineOp, Permission>;
export function permissionForOp(op: DeadlineOp): Permission | null;
export function canWriteDeadline(deadline: Deadline, ctx: WriteContext, perm: Permission): boolean;
export function canCreateDeadline(ctx: WriteContext): boolean;
export function canPerformOp(deadline: Deadline, ctx: WriteContext, op: DeadlineOp): boolean;
export function canAccessIntimation(intimation: { scope: Scope; suggestedResponsibleId?: string; deadlineId?: string }, ctx: WriteContext, resolveResponsible?: (deadlineId: string) => string | undefined): boolean;
export function canWriteIntimation(intimation: { scope: Scope }, ctx: WriteContext, perm: Permission): boolean;
