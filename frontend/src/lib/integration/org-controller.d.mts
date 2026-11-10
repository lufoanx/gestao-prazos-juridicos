import type { ApiClient } from "./api-client.d.mts";
import type { OrgClient } from "./org-client.d.mts";
import type { Office, OwnMembership, MemberAdmin, MemberPublic } from "./dto.d.mts";
export const ADMIN_PERMS: readonly string[];
export const MEMBER_PERMS: readonly string[];
export const ALL_PERMS: readonly string[];
export interface Capabilities { isAdmin: boolean; canManageTeam: boolean; canManageOffice: boolean; canGrantEntry: boolean; visibilityAll: boolean }
export function capabilities(m: OwnMembership | null | undefined): Capabilities;
export function grantablePermissions(actor: OwnMembership | null | undefined): string[];
export function canEditTarget(actor: OwnMembership | null | undefined, actorId: string, target: (MemberAdmin | MemberPublic) & { permissions?: string[] }): boolean;
export type Scope = "personal" | "office";
export interface OrgState {
  status: "idle" | "loading" | "ready" | "error" | "unavailable";
  userId: string | null; office: Office | null; membership: OwnMembership | null; scope: Scope; error: string | null;
}
export interface OrgController {
  readonly state: OrgState;
  subscribe(l: (s: OrgState) => void): () => void;
  refresh(opts?: { userId?: string | null; preferOffice?: boolean }): Promise<OrgState>;
  reset(userId: string | null): void;
  selectScope(scope: Scope): boolean;
  revalidate(): Promise<void>;
  changed(opts?: { preferOffice?: boolean }): Promise<OrgState>;
}
export function createOrgController(opts: {
  org: OrgClient; api: ApiClient; channel?: { postMessage(m: unknown): void; onmessage: ((ev: MessageEvent) => void) | null } | null;
  onReset?: (info: { reason: string }) => void;
  scopeStore?: { get(userId: string): Scope | null; set(userId: string, scope: Scope): void } | null;
}): OrgController;
