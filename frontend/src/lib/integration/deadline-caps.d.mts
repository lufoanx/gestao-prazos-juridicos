import type { OwnMembership } from "./dto.d.mts";
export interface DeadlineCaps { canRead: boolean; canCreate: boolean; canEdit: boolean; canComplete: boolean; canComment: boolean; canTransferOut: boolean; visibilityAll: boolean }
export function deadlineCaps(scope: "personal" | "office", membership: OwnMembership | null | undefined): DeadlineCaps;
export function canTransferToOffice(membership: OwnMembership | null | undefined): boolean;
export function selectableResponsibles(scope: "personal" | "office", membership: OwnMembership | null | undefined, members: Array<{ userId: string; name: string }> | null | undefined, me: { id: string; name: string }): Array<{ userId: string; name: string }>;
export function displayName(userId: string | undefined | null, names: Map<string, string> | null | undefined, me?: { id: string; name: string } | null): string;
import type { Deadline } from "./dto.d.mts";
export function scopeMatches(d: { scope: Deadline["scope"] }, ctx: { scope: "personal" | "office"; officeId: string | null; userId: string | null }): boolean;
export function resourceCaps(d: Deadline, membership: OwnMembership | null | undefined, userId: string | null): DeadlineCaps;
