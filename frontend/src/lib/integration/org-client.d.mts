import type { ApiClient } from "./api-client.d.mts";
import type * as D from "./dto.d.mts";
export interface OrgClient {
  membership(): Promise<D.CurrentOffice>;
  createOffice(body: { name: string; roleLabel?: string; practiceAreas?: string[] }): Promise<D.CurrentOffice>;
  office(officeId: string): Promise<D.Office>;
  renameOffice(officeId: string, name: string): Promise<D.Office>;
  members(officeId: string): Promise<D.MembersResponse>;
  updateMember(officeId: string, userId: string, body: D.UpdateMember): Promise<D.MemberAdmin>;
  promote(officeId: string, userId: string): Promise<D.MemberAdmin>;
  removeMember(officeId: string, userId: string, reassignTo?: string): Promise<null>;
  leave(officeId: string, opts?: { successorUserId?: string; reassignTo?: string }): Promise<null>;
  joinCode(officeId: string): Promise<{ joinCode: string }>;
  rotateJoinCode(officeId: string): Promise<{ joinCode: string }>;
  invitations(officeId: string): Promise<D.InvitationAdmin[]>;
  createInvitation(officeId: string, roleLabel?: string): Promise<D.InvitationCreated>;
  revokeInvitation(officeId: string, invitationId: string): Promise<D.InvitationAdmin>;
  officeRequests(officeId: string): Promise<D.OfficeJoinRequest[]>;
  approveRequest(officeId: string, requestId: string): Promise<unknown>;
  rejectRequest(officeId: string, requestId: string): Promise<unknown>;
  lookupInvitation(token: string): Promise<D.InvitationLookup>;
  acceptInvitation(token: string): Promise<D.CurrentOffice>;
  requestJoin(joinCode: string): Promise<D.OwnJoinRequest>;
  myRequests(): Promise<D.OwnJoinRequest[]>;
  cancelRequest(requestId: string): Promise<D.OwnJoinRequest>;
}
export function createOrgClient(api: ApiClient): OrgClient;
