import type { Deadline, Comment, Attachment, AuditEvent, Notification, Intimation, Scope } from "@/types/domain";

export interface StoredData {
  version: number;
  deadlines: Deadline[];
  comments: Comment[];
  attachments: Attachment[];
  audit: AuditEvent[];
  notifications: Notification[];
  removedAttachmentIds: string[];
  intimations: Intimation[];
  removedIntimationIds: string[];
}

export function isValidScope(s: unknown): s is Scope;
export function isValidDeadline(d: unknown): d is Deadline;
export function sanitizeStored(parsed: unknown, version: number): StoredData | null;
export const EDITABLE_FIELDS: (keyof Deadline)[];
export function sanitizePatch(patch: Partial<Deadline>): Partial<Deadline>;
