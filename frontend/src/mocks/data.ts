// Sementes DEMONSTRATIVAS — nomes, processos e tribunais inteiramente fictícios.
// Não extrair conteúdo dos prints de referência. Datas ancoradas no relógio
// demonstrativo (clock.mjs, DEMO_TODAY = 2026-09-16) para não ficarem obsoletas.
import type { User, Office, Membership, Deadline, Intimation, Notification, Comment, Attachment, AuditEvent } from "@/types/domain";

export const DEMO_USER_ID = "u1";
export const DEMO_OFFICE_ID = "office-demo";

export const demoUsers: User[] = [
  { id: "u1", name: "Paula Andrade", email: "paula@exemplo.test" },
  { id: "u2", name: "Rafael Neves", email: "rafael@exemplo.test" },
  { id: "u3", name: "Camila Rocha", email: "camila@exemplo.test" },
];

export const demoOffice: Office = { id: "office-demo", name: "Escritório Demonstrativo" };

export const demoMembership: Membership = {
  userId: "u1",
  officeId: "office-demo",
  roleLabel: "Advogada · Administradora",
  practiceAreas: ["Cível", "Trabalhista"],
  permissions: ["deadline.read", "deadline.create", "deadline.edit", "deadline.complete", "deadline.transfer", "team.manage", "office.manage"],
  visibility: "all",
};

// Datas relativas ao DEMO_TODAY (2026-09-16):
//  15 = vencido | 16 = hoje | 17/18/19 = próximo | 24/30 = futuro
export const demoDeadlines: Deadline[] = [
  // ---- Ambiente PESSOAL (dono: u1) ----
  { id: "p-101", scope: { kind: "personal", ownerId: "u1" }, title: "Contestação — locação residencial", caseNumber: "0001234-56.2026.8.24.0038", court: "TJSC · 2ª Vara Cível", practiceArea: "Cível", responsibleId: "u1", status: "open", priority: "high", startDate: "2026-09-11", dueDate: "2026-09-15", countingMode: "business", duration: 15, reviewed: true },
  { id: "p-102", scope: { kind: "personal", ownerId: "u1" }, title: "Manifestação sobre documentos", caseNumber: "0004521-88.2026.8.24.0091", court: "TJSC · 1ª Vara Cível", practiceArea: "Cível", responsibleId: "u1", status: "open", priority: "high", startDate: "2026-09-12", dueDate: "2026-09-16", countingMode: "business", duration: 5, reviewed: true, agendaTime: "11:00" },
  { id: "p-103", scope: { kind: "personal", ownerId: "u1" }, title: "Réplica à contestação", caseNumber: "0007781-22.2026.8.24.0005", court: "TJSC · Vara Única", practiceArea: "Cível", responsibleId: "u1", status: "open", priority: "normal", startDate: "2026-09-10", dueDate: "2026-09-16", countingMode: "business", duration: 10, reviewed: true, agendaTime: "16:30" },
  { id: "p-104", scope: { kind: "personal", ownerId: "u1" }, title: "Juntada de procuração", caseNumber: "0009087-10.2026.8.24.0011", court: "TJSC · 3ª Vara Cível", practiceArea: "Cível", responsibleId: "u1", status: "open", priority: "normal", startDate: "2026-09-14", dueDate: "2026-09-18", countingMode: "business", duration: 5, reviewed: true },
  { id: "p-105", scope: { kind: "personal", ownerId: "u1" }, title: "Cumprimento de sentença — cálculo", caseNumber: "0002234-77.2026.8.24.0023", court: "TJSC · 4ª Vara Cível", practiceArea: "Cível", responsibleId: "u1", status: "open", priority: "normal", startDate: "2026-09-12", dueDate: "2026-09-24", countingMode: "calendar", duration: 15, reviewed: true },
  { id: "p-106", scope: { kind: "personal", ownerId: "u1" }, title: "Recurso inominado", caseNumber: "0003345-90.2026.8.24.0090", court: "Turma Recursal · JEC", practiceArea: "Cível", responsibleId: "u1", status: "completed", priority: "normal", startDate: "2026-09-01", dueDate: "2026-09-12", countingMode: "business", duration: 10, reviewed: true },
  { id: "p-107", scope: { kind: "personal", ownerId: "u1" }, title: "Alegações finais", caseNumber: "0006612-45.2026.8.24.0033", court: "TJSC · 2ª Vara Cível", practiceArea: "Cível", responsibleId: "u1", status: "completed", priority: "normal", startDate: "2026-08-28", dueDate: "2026-09-09", countingMode: "business", duration: 15, reviewed: true },

  // ---- Ambiente ESCRITÓRIO (office-demo) ----
  { id: "o-201", scope: { kind: "office", officeId: "office-demo" }, title: "Recurso ordinário trabalhista", caseNumber: "0010045-11.2026.5.12.0004", court: "TRT 12ª Região · 4ª Vara", practiceArea: "Trabalhista", responsibleId: "u2", status: "open", priority: "high", startDate: "2026-09-10", dueDate: "2026-09-15", countingMode: "business", duration: 8, reviewed: true },
  { id: "o-202", scope: { kind: "office", officeId: "office-demo" }, title: "Contrarrazões de apelação", caseNumber: "0011122-33.2026.8.24.0018", court: "TJSC · 1ª Câmara de Direito Civil", practiceArea: "Cível", responsibleId: "u1", status: "open", priority: "high", startDate: "2026-09-11", dueDate: "2026-09-16", countingMode: "business", duration: 15, reviewed: true, agendaTime: "09:30" },
  { id: "o-203", scope: { kind: "office", officeId: "office-demo" }, title: "Impugnação ao cumprimento", caseNumber: "0012233-44.2026.8.24.0079", court: "TJSC · 5ª Vara Cível", practiceArea: "Cível", responsibleId: "u3", status: "open", priority: "normal", startDate: "2026-09-13", dueDate: "2026-09-17", countingMode: "business", duration: 15, reviewed: true },
  { id: "o-204", scope: { kind: "office", officeId: "office-demo" }, title: "Razões finais — reclamatória", caseNumber: "0013344-55.2026.5.12.0012", court: "TRT 12ª Região · 12ª Vara", practiceArea: "Trabalhista", responsibleId: "u2", status: "open", priority: "normal", startDate: "2026-09-12", dueDate: "2026-09-19", countingMode: "business", duration: 10, reviewed: true },
  { id: "o-205", scope: { kind: "office", officeId: "office-demo" }, title: "Embargos de declaração", caseNumber: "0014455-66.2026.8.24.0002", court: "TJSC · 3ª Câmara", practiceArea: "Cível", responsibleId: "u1", status: "open", priority: "normal", startDate: "2026-09-15", dueDate: "2026-09-16", countingMode: "business", duration: 5, reviewed: true, agendaTime: "14:00" },
  { id: "o-206", scope: { kind: "office", officeId: "office-demo" }, title: "Petição de habilitação", caseNumber: "0015566-77.2026.8.24.0044", court: "TJSC · Vara de Família", practiceArea: "Família", responsibleId: "u3", status: "open", priority: "normal", startDate: "2026-09-14", dueDate: "2026-09-30", countingMode: "calendar", duration: 30, reviewed: true },
  { id: "o-207", scope: { kind: "office", officeId: "office-demo" }, title: "Manifestação sobre perícia", caseNumber: "0016677-88.2026.5.12.0007", court: "TRT 12ª Região · 7ª Vara", practiceArea: "Trabalhista", responsibleId: "u2", status: "completed", priority: "normal", startDate: "2026-08-30", dueDate: "2026-09-11", countingMode: "business", duration: 10, reviewed: true },
];

export const demoIntimations: Intimation[] = [
  { id: "i-301", scope: { kind: "personal", ownerId: "u1" }, fileName: "intimacao-0004521.pdf", status: "awaiting_review", receivedAt: "2026-09-16", suggestedTitle: "Manifestação — prazo sugerido", suggestedDueDate: "2026-09-23" },
  { id: "i-302", scope: { kind: "personal", ownerId: "u1" }, fileName: "intimacao-0007781.pdf", status: "processing", receivedAt: "2026-09-16" },
  { id: "i-401", scope: { kind: "office", officeId: "office-demo" }, fileName: "intimacao-0011122.pdf", status: "awaiting_review", receivedAt: "2026-09-16", suggestedTitle: "Recurso — prazo sugerido", suggestedDueDate: "2026-09-25" },
  { id: "i-402", scope: { kind: "office", officeId: "office-demo" }, fileName: "intimacao-0013344.pdf", status: "awaiting_review", receivedAt: "2026-09-15", suggestedTitle: "Contrarrazões — prazo sugerido", suggestedDueDate: "2026-09-22" },
  { id: "i-403", scope: { kind: "office", officeId: "office-demo" }, fileName: "intimacao-0016677.pdf", status: "failed", receivedAt: "2026-09-15" },
];

export const demoNotifications: Notification[] = [
  { id: "n-501", scope: { kind: "personal", ownerId: "u1" }, title: "Prazo vencido: Contestação — locação residencial", read: false, deadlineId: "p-101", createdAt: "2026-09-16" },
  { id: "n-502", scope: { kind: "personal", ownerId: "u1" }, title: "Vence hoje: Manifestação sobre documentos", read: false, deadlineId: "p-102", createdAt: "2026-09-16" },
  { id: "n-503", scope: { kind: "personal", ownerId: "u1" }, title: "Nova intimação para revisão", read: true, deadlineId: undefined, createdAt: "2026-09-16" },
  { id: "n-601", scope: { kind: "office", officeId: "office-demo" }, title: "Prazo vencido: Recurso ordinário trabalhista", read: false, deadlineId: "o-201", createdAt: "2026-09-16" },
  { id: "n-602", scope: { kind: "office", officeId: "office-demo" }, title: "Vence hoje: Contrarrazões de apelação", read: false, deadlineId: "o-202", createdAt: "2026-09-16" },
  { id: "n-603", scope: { kind: "office", officeId: "office-demo" }, title: "2 intimações aguardando revisão", read: false, createdAt: "2026-09-16" },
];


export const demoComments: Comment[] = [
  { id: "c-001", deadlineId: "p-102", authorId: "u1", text: "Documentos recebidos do cliente; falta conferir a procuração.", createdAt: "2026-09-14" },
  { id: "c-002", deadlineId: "o-202", authorId: "u2", text: "Minuta inicial anexada. Revisar fundamentação antes de protocolar.", createdAt: "2026-09-15" },
];

export const demoAttachments: Attachment[] = [
  { id: "a-001", deadlineId: "o-202", name: "minuta-contrarrazoes.pdf", size: 184320, demoOnly: true },
];

export const demoAudit: AuditEvent[] = [
  { id: "h-001", deadlineId: "p-102", actorId: "u1", action: "created", createdAt: "2026-09-12", details: "Prazo cadastrado" },
  { id: "h-002", deadlineId: "p-102", actorId: "u1", action: "commented", createdAt: "2026-09-14", details: "Comentário adicionado" },
  { id: "h-003", deadlineId: "o-202", actorId: "u2", action: "created", createdAt: "2026-09-11", details: "Prazo cadastrado" },
  { id: "h-004", deadlineId: "o-202", actorId: "u2", action: "attached", createdAt: "2026-09-15", details: "Anexo: minuta-contrarrazoes.pdf" },
];

// ---- Etapa 5: equipe/escritório compartilhados (roster demonstrativo) ----
import type { JoinRequest, Invitation } from "@/types/domain";

// Permissões padrão de um membro comum (sem gestão de equipe/escritório).
export const MEMBER_PERMS: Membership["permissions"] = ["deadline.read", "deadline.create", "deadline.edit", "deadline.complete"];

// Roster do escritório semeado (office-demo): Paula (admin) + Rafael + Camila (membros).
export const demoMemberships: Membership[] = [
  demoMembership,
  { userId: "u2", officeId: "office-demo", roleLabel: "Advogado", practiceAreas: ["Trabalhista"], permissions: [...MEMBER_PERMS], visibility: "all" },
  { userId: "u3", officeId: "office-demo", roleLabel: "Advogada", practiceAreas: ["Cível", "Família"], permissions: [...MEMBER_PERMS], visibility: "assigned" },
];

export const demoInvites: Invitation[] = [];
export const demoJoinRequests: JoinRequest[] = [];
