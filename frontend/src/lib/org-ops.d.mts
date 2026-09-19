import type { Office, Membership, Invitation, JoinRequest, User, Permission } from "@/types/domain";

export interface OrgState {
  offices: Office[];
  memberships: Membership[];
  invites: Invitation[];
  joinRequests: JoinRequest[];
  leftKeys?: string[];
}
export interface RemoveCheck { ok: boolean; reason: string | null; }
export interface OrgCtx { userId: string; }
export interface OrgDeps { newId: (prefix?: string) => string; today: string; addDays: (d: string, n: number) => string; }
export type InviteState = "valid" | "expired" | "revoked" | "used" | "invalid";

export const ALL_PERMS: Permission[];
export const MEMBER_PERMS: Permission[];
export function membershipOf(state: OrgState, officeId: string, userId: string): Membership | undefined;
export function adminsOf(state: OrgState, officeId: string): Membership[];
export function officeOfUser(state: OrgState, userId: string): Membership | undefined;

export function opUpdateOffice(state: OrgState, ctx: OrgCtx, officeId: string, patch: { name?: string }): OrgState;
export function opSetMemberProfile(state: OrgState, ctx: OrgCtx, officeId: string, targetUserId: string, patch: { roleLabel?: string; practiceAreas?: string[]; visibility?: "all" | "assigned" }): OrgState;
export function opSetMemberPermissions(state: OrgState, ctx: OrgCtx, officeId: string, targetUserId: string, permissions: Permission[]): OrgState;
export function opRemoveMember(state: OrgState, ctx: OrgCtx, officeId: string, targetUserId: string): OrgState;
export function validateRemoveMember(state: OrgState, officeId: string, actorUserId: string, targetUserId: string, openCount: number, reassignTo: string | undefined): RemoveCheck;
export function opTransferAdmin(state: OrgState, ctx: OrgCtx, officeId: string, targetUserId: string): OrgState;
export function opLeaveOffice(state: OrgState, ctx: OrgCtx, officeId: string): OrgState;
export function validateLeaveOffice(state: OrgState, officeId: string, userId: string): RemoveCheck;
export function opLeaveOrTransferOffice(state: OrgState, ctx: OrgCtx, officeId: string, transferTo: string | undefined): { state: OrgState; ok: boolean; reason: string | null };
export function opCreateInvite(state: OrgState, ctx: OrgCtx, officeId: string, deps: OrgDeps, roleLabel?: string): { state: OrgState; invite: Invitation | null };
export function opRevokeInvite(state: OrgState, ctx: OrgCtx, inviteId: string): OrgState;
export function inviteState(invite: Invitation | undefined, today: string): InviteState;
export function opAcceptInvite(state: OrgState, actorUser: User, token: string, deps: OrgDeps): { state: OrgState; officeId: string | null; reason: string | null; membership?: Membership };
export function opRequestJoin(state: OrgState, actorUser: User, officeId: string, deps: OrgDeps): { state: OrgState; id: string | null; reason: string | null };
export function opApproveRequest(state: OrgState, ctx: OrgCtx, requestId: string): { state: OrgState; reason: string | null };
export function opRejectRequest(state: OrgState, ctx: OrgCtx, requestId: string): OrgState;
