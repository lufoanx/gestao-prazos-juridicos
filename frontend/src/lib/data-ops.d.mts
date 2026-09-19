import type { Deadline, Comment, Attachment, AuditEvent, Notification, Intimation } from "@/types/domain";
import type { WriteContext } from "@/lib/deadline-guards.d.mts";
import type { NewDeadlineInput } from "@/context/DataContext";

export interface DataState {
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
export interface OpDeps { newId: (prefix?: string) => string; today: string; }
export interface Seeds { deadlines: Deadline[]; attachments: Attachment[]; intimations?: Intimation[]; notifications?: Notification[]; }

export interface IntimationSuggestion {
  suggestedTitle?: string; suggestedCaseNumber?: string; suggestedCourt?: string;
  suggestedArea?: string; suggestedResponsibleId?: string; suggestedDueDate?: string;
}

export function opCreateDeadline(state: DataState, ctx: WriteContext, input: NewDeadlineInput, deps: OpDeps): { state: DataState; id: string | null };
export function opUpdateDeadline(state: DataState, ctx: WriteContext, id: string, patch: Partial<Deadline>, deps: OpDeps, seeds: Seeds): DataState;
export function opSetStatus(state: DataState, ctx: WriteContext, id: string, status: Deadline["status"], deps: OpDeps, seeds: Seeds): DataState;
export function opAddComment(state: DataState, ctx: WriteContext, id: string, text: string, deps: OpDeps, seeds: Seeds): DataState;
export function opAddAttachment(state: DataState, ctx: WriteContext, id: string, file: { name: string; size: number }, deps: OpDeps, seeds: Seeds): DataState;
export function opRemoveAttachment(state: DataState, ctx: WriteContext, attachmentId: string, deps: OpDeps, seeds: Seeds): DataState;

export function opUploadIntimation(state: DataState, ctx: WriteContext, file: { name: string; demoForceFail?: boolean }, deps: OpDeps): { state: DataState; id: string | null };
export function opProcessIntimation(state: DataState, ctx: WriteContext, id: string, outcome: "success" | "fail", suggestion: IntimationSuggestion | null, deps: OpDeps, seeds: Seeds): DataState;
export function opRetryIntimation(state: DataState, ctx: WriteContext, id: string, deps: OpDeps, seeds: Seeds): DataState;
export function opRemoveIntimation(state: DataState, ctx: WriteContext, id: string, deps: OpDeps, seeds: Seeds): DataState;
export function opConfirmIntimationReview(state: DataState, ctx: WriteContext, id: string, review: NewDeadlineInput, deps: OpDeps, seeds: Seeds): { state: DataState; deadlineId: string | null };
export function opMarkNotificationRead(state: DataState, ctx: WriteContext, id: string, seeds: Seeds): DataState;
export function opMarkAllNotificationsRead(state: DataState, ctx: WriteContext, seeds: Seeds): DataState;
export function opTransferDeadlineToOffice(state: DataState, ctx: WriteContext, id: string, officeId: string, deps: OpDeps, seeds: Seeds): DataState;
export function opReassignResponsibleForOffice(state: DataState, ctx: WriteContext, officeId: string, fromUserId: string, toUserId: string, deps: OpDeps, seeds: Seeds): DataState;
