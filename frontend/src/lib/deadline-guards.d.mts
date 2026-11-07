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
export type ResponsibleResolver = (deadlineId: string) => string | undefined;
export interface IntimationAccessTarget { scope: Scope; createdBy?: string; suggestedResponsibleId?: string; deadlineId?: string }
export function makeResponsibleResolver(
  deadlines: ReadonlyArray<{ id: string; scope?: Scope; responsibleId?: string }> | null | undefined,
  scope?: Scope,
): ResponsibleResolver;
export function canAccessIntimation(intimation: IntimationAccessTarget, ctx: WriteContext, resolveResponsible?: ResponsibleResolver): boolean;
export function canWriteIntimation(intimation: IntimationAccessTarget, ctx: WriteContext, perm: Permission, resolveResponsible?: ResponsibleResolver): boolean;
