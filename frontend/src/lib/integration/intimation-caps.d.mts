import type { Intimation, OwnMembership, IntimationDraft } from "./dto.d.mts";
export const PENDING: readonly string[];
export interface IntimationCaps { canEditDraft: boolean; canConfirm: boolean; canDiscard: boolean; canRetry: boolean }
export function intimationCaps(i: Intimation, membership: OwnMembership | null | undefined, userId: string | null): IntimationCaps;
export function canRegisterIntimation(scope: "personal" | "office", membership: OwnMembership | null | undefined): boolean;
export { scopeMatches } from "./deadline-caps.mjs";
export function draftChanges(original: IntimationDraft, form: Record<string, string | number | null | undefined>, originalSuggested: string | null, formSuggested: string | null | ""): Record<string, unknown>;
export function linkedDeadline(i: Pick<Intimation, "deadlineId" | "linked">): { state: "readable" | "protected" | "none"; href: string | null };
