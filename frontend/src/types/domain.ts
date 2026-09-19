// Tipos de domínio do PrazoAI.
// Foco EXCLUSIVO em prazos jurídicos. Número do processo, partes e tribunal são
// campos associados ao prazo — não um módulo de gestão processual.

export type Scope =
  | { kind: "personal"; ownerId: string }
  | { kind: "office"; officeId: string };

export type Permission =
  | "deadline.read"
  | "deadline.create"
  | "deadline.edit"
  | "deadline.complete"
  | "deadline.transfer"
  | "team.manage"
  | "office.manage";

export interface User { id: string; name: string; email: string; }

export interface Office { id: string; name: string; }

export interface Membership {
  userId: string;
  officeId: string;
  roleLabel: string;
  practiceAreas: string[];
  permissions: Permission[];
  visibility: "assigned" | "all";
}

export interface Deadline {
  id: string;
  scope: Scope;
  title: string;
  caseNumber: string;
  court: string;
  practiceArea: string;
  responsibleId: string;
  status: "open" | "completed" | "cancelled";
  priority: "normal" | "high";
  startDate: string;   // data civil YYYY-MM-DD
  dueDate: string;     // data civil YYYY-MM-DD (vencimento demonstrativo)
  countingMode: "business" | "calendar";
  duration: number;
  reviewed: boolean;
  /** Horário sugerido para a agenda do dia (HH:MM). Opcional, demonstrativo. */
  agendaTime?: string;
}

export interface Comment { id: string; deadlineId: string; authorId: string; text: string; createdAt: string; }
export interface Attachment { id: string; deadlineId: string; name: string; size: number; demoOnly: true; }
export interface AuditEvent { id: string; deadlineId: string; actorId: string; action: string; createdAt: string; details: string; }
export interface Invitation { id: string; officeId: string; token: string; expiresAt: string; status: "pending" | "accepted" | "revoked" | "expired"; roleLabel?: string; createdAt?: string; }
export interface JoinRequest { id: string; officeId: string; userId: string; name: string; email: string; status: "pending" | "approved" | "rejected"; createdAt: string; }
export interface Notification { id: string; scope: Scope; title: string; read: boolean; deadlineId?: string; createdAt: string; }

/** Intimação demonstrativa. O processamento é SIMULADO — nunca há extração real de PDF nem IA real. */
export interface Intimation {
  id: string;
  scope: Scope;
  fileName: string;
  status: "sent" | "processing" | "awaiting_review" | "reviewed" | "failed";
  receivedAt: string;   // data civil YYYY-MM-DD
  /** Dados SUGERIDOS por processamento SIMULADO — não derivam do PDF e exigem conferência humana. */
  suggestedTitle?: string;
  suggestedCaseNumber?: string;
  suggestedCourt?: string;
  suggestedArea?: string;
  suggestedResponsibleId?: string;
  suggestedDueDate?: string;
  /** Prazo criado a partir desta intimação (proteção contra duplicação). */
  deadlineId?: string;
  /** Demo: se true, o processamento simulado resolve em falha (persistido p/ sobreviver a reload). */
  demoForceFail?: boolean;
}
