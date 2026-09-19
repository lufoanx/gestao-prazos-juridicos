import type { User, Office, Membership, Permission } from "@/types/domain";

export type ProfileKind = "autonomo" | "office-admin" | "office-member" | null;

export interface DemoPreferences {
  practiceArea?: string;
  digest?: "daily" | "weekly" | "none";
}

export interface DemoSession {
  version: number;
  user: User | null;
  profile: ProfileKind;
  preferences: DemoPreferences;
  office: Office | null;
  membership: Membership | null;
}

export type AcceptInviteReason = "already-member" | "second-office";
export interface AcceptInviteCheck { ok: boolean; reason?: AcceptInviteReason; }

export type CreateOfficeReason = "already-office";
export interface CreateOfficeCheck { ok: boolean; reason?: CreateOfficeReason; }

export interface AcceptInviteOpts {
  roleLabel?: string;
  practiceAreas?: string[];
  permissions?: Permission[];
  visibility?: "assigned" | "all";
}

export const SESSION_VERSION: number;
export const DEMO_USER_ID: string;
export const ADMIN_PERMISSIONS: Permission[];
export const MEMBER_PERMISSIONS: Permission[];

export function defaultSession(): DemoSession;
export function isValidSession(s: unknown): boolean;
export function applySignUp(session: DemoSession, data: { name: string; email: string }): DemoSession;
export function applySignIn(session: DemoSession, data: { name?: string; email: string }): DemoSession;
export function applyAutonomo(session: DemoSession, preferences?: DemoPreferences): DemoSession;
export function canCreateOffice(session: DemoSession): CreateOfficeCheck;
export function applyCreateOffice(session: DemoSession, data: { name: string; role?: string; area?: string }): DemoSession;
export function canAcceptInvite(session: DemoSession, inviteOfficeId: string): AcceptInviteCheck;
export function applyAcceptInvite(session: DemoSession, office: Office, opts?: AcceptInviteOpts): DemoSession;
export function resetSession(): DemoSession;
export function applyUpdateProfile(session: DemoSession, data: { name?: string }): DemoSession;
export function applyUpdatePreferences(session: DemoSession, preferences: DemoPreferences): DemoSession;
export function applyLeaveOffice(session: DemoSession): DemoSession;
export function defaultScopeKind(session: DemoSession): "personal" | "office";
