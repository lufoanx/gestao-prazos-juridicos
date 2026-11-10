// DTOs da API (espelham os schemas do backend) usados na entrega 6.1.
export interface PublicUser { id: string; name: string; email: string; createdAt: string; }
export interface SessionResponse { authenticated: boolean; user?: PublicUser; }
export interface LoginResponse { user: PublicUser; }

// ---- 6.2: escritórios, equipe, convites e solicitações (espelham backend/app/schemas/org.py)
export interface Office { id: string; name: string; createdAt: string; }
export interface OwnMembership {
  officeId: string; roleLabel: string; practiceAreas: string[]; permissions: string[];
  visibility: "all" | "assigned"; joinedAt: string;
}
export interface CurrentOffice { office: Office | null; membership: OwnMembership | null; }
export interface MemberPublic { userId: string; name: string; roleLabel: string; practiceAreas: string[]; }
export interface MemberAdmin extends MemberPublic { email: string; permissions: string[]; visibility: "all" | "assigned"; joinedAt: string; }
export interface MembersResponse { projection: "public" | "admin"; members: Array<MemberAdmin | MemberPublic>; }
export interface UpdateMember { roleLabel?: string; practiceAreas?: string[]; visibility?: "all" | "assigned"; permissions?: string[]; }
export interface InvitationAdmin {
  id: string; roleLabel: string; state: "valid" | "expired" | "revoked" | "used";
  createdAt: string; expiresAt: string; closedAt?: string | null;
}
export interface InvitationCreated extends InvitationAdmin { token: string; }
export interface InvitationLookup { state: "valid" | "expired" | "revoked" | "used" | "invalid"; officeName?: string; }
export interface OwnJoinRequest {
  id: string; officeName: string | null; status: "pending" | "approved" | "rejected" | "cancelled";
  createdAt: string; decidedAt?: string | null;
}
export interface OfficeJoinRequest {
  id: string; requester: { userId: string; name: string; email: string } | null;
  status: "pending" | "approved" | "rejected" | "cancelled"; createdAt: string; decidedAt?: string | null;
}

// ---- 6.3: prazos e calendário (espelham backend/app/schemas/deadlines.py)
export type DeadlineStatus = "open" | "completed" | "cancelled";
export type UrgencyLevel = "overdue" | "today" | "soon" | "upcoming";
export interface DeadlineScope { kind: "personal" | "office"; ownerId: string | null; officeId: string | null; }
export interface Deadline {
  id: string; scope: DeadlineScope; title: string; caseNumber: string; court: string; practiceArea: string;
  responsibleId: string; status: DeadlineStatus; priority: "normal" | "high"; startDate: string; dueDate: string;
  countingMode: "business" | "calendar"; duration: number; reviewed: boolean; agendaTime: string | null;
  createdBy: string; createdAt: string; updatedAt: string; version: number;
  urgency: { level: UrgencyLevel; days: number } | null;
}
export interface DeadlinePage { items: Deadline[]; page: number; perPage: number; total: number; pageCount: number; referenceDate: string; }
export interface DeadlineComment { id: string; deadlineId: string; authorId: string; text: string; createdAt: string; }
export interface CommentPage { items: DeadlineComment[]; page: number; perPage: number; total: number; }
export interface HistoryEvent { id: string; actorId: string; action: string; at: string; details: Record<string, unknown>; }
export interface HistoryPage { items: HistoryEvent[]; page: number; perPage: number; total: number; }
export interface CalendarPage {
  year: number; month: number; referenceDate: string; timezone: string; items: Deadline[];
  countsByDay: Record<string, number>; page: number; perPage: number; total: number; pageCount: number;
  hasNextPage: boolean; nextPage: number | null;
}
export interface DeadlineInput {
  title: string; caseNumber: string; court: string; practiceArea: string; responsibleId?: string;
  priority: "normal" | "high"; startDate: string; dueDate: string; countingMode: "business" | "calendar";
  duration: number; agendaTime?: string | null; reviewed: boolean;
}

// ---- 6.4: intimações e notificações (espelham backend/app/schemas/intimations.py)
export type IntimationStatus = "processing" | "awaiting_review" | "failed" | "reviewed" | "discarded";
export interface IntimationDraft {
  title: string | null; caseNumber: string | null; court: string | null; practiceArea: string | null;
  startDate: string | null; dueDate: string | null; countingMode: "business" | "calendar" | null;
  duration: number | null; priority: "normal" | "high" | null; agendaTime: string | null;
}
export interface Intimation {
  id: string; scope: DeadlineScope;
  file: { name: string; sizeBytes: number; contentType: string; storage: "not_stored" | string };
  receivedAt: string; status: IntimationStatus;
  processing: { status: "not_available" | "pending" | "completed" | "failed" | string; attempts: number; failureCode: string | null };
  draft: IntimationDraft; suggestion: { source: string; fields: Record<string, unknown> } | null;
  suggestedResponsibleId: string | null; deadlineId: string | null; linked: boolean;
  createdBy: string; createdAt: string; updatedAt: string; closedAt: string | null; version: number;
}
export interface IntimationPage { items: Intimation[]; page: number; perPage: number; total: number; }
export interface IntimationEventPage { items: HistoryEvent[]; page: number; perPage: number; total: number; }
export interface ConfirmResult { intimation: Intimation; deadline: Deadline; created: boolean; }
export interface RegisterIntimation { fileName: string; sizeBytes: number; contentType: "application/pdf"; receivedAt: string; suggestedResponsibleId?: string; }
export type NotificationSummary = Record<string, unknown>;
export interface InboxNotification {
  id: string; kind: "deadline_assigned" | "intimation_assigned" | string; resourceType: "deadline" | "intimation" | string;
  resourceId: string; summary: NotificationSummary; createdAt: string; readAt: string | null;
}
export interface NotificationPage { items: InboxNotification[]; page: number; perPage: number; total: number; unread: number; retentionPolicy: string; }
