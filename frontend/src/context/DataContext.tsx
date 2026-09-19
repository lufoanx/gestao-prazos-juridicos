"use client";
import {
  createContext, useContext, useState, useEffect, useMemo, useCallback, type ReactNode,
} from "react";
import type { Deadline, Comment, Attachment, AuditEvent, Notification, Intimation, Permission } from "@/types/domain";
import {
  demoDeadlines, demoComments, demoAttachments, demoAudit, demoNotifications, demoIntimations,
} from "@/mocks/data";
import { useScope } from "@/context/ScopeContext";
import { getDemoToday } from "@/lib/clock.mjs";
import { newId } from "@/lib/ids.mjs";
import { sanitizeStored } from "@/lib/data-sanitize.mjs";
import {
  opCreateDeadline, opUpdateDeadline, opSetStatus, opAddComment, opAddAttachment, opRemoveAttachment,
  opUploadIntimation, opProcessIntimation, opRetryIntimation, opRemoveIntimation, opConfirmIntimationReview,
  opMarkNotificationRead, opMarkAllNotificationsRead, opTransferDeadlineToOffice, opReassignResponsibleForOffice,
} from "@/lib/data-ops.mjs";
import type { IntimationSuggestion } from "@/lib/data-ops.d.mts";

const STORAGE_KEY = "prazoai:demo-data:v1";
const DATA_VERSION = 1;

interface PersistedData {
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

function emptyData(): PersistedData {
  return { version: DATA_VERSION, deadlines: [], comments: [], attachments: [], audit: [], notifications: [], removedAttachmentIds: [], intimations: [], removedIntimationIds: [] };
}

/** Sementes vencem por id quando há cópia persistida (edição/conclusão de prazos semeados). */
function mergeById<T extends { id: string }>(seeds: T[], overrides: T[]): T[] {
  const map = new Map<string, T>();
  for (const s of seeds) map.set(s.id, s);
  for (const o of overrides) map.set(o.id, o);
  return [...map.values()];
}

export interface NewDeadlineInput {
  title: string; caseNumber: string; court: string; practiceArea: string;
  responsibleId?: string; priority: "normal" | "high";
  startDate: string; dueDate: string; countingMode: "business" | "calendar";
  duration: number; agendaTime?: string;
}

interface DataApi {
  deadlines: Deadline[];
  intimations: Intimation[];
  notifications: Notification[];
  getDeadline: (id: string) => Deadline | undefined;
  commentsFor: (id: string) => Comment[];
  attachmentsFor: (id: string) => Attachment[];
  historyFor: (id: string) => AuditEvent[];
  createDeadline: (input: NewDeadlineInput) => string | null;
  updateDeadline: (id: string, patch: Partial<Deadline>) => void;
  setStatus: (id: string, status: Deadline["status"]) => void;
  addComment: (id: string, text: string) => void;
  addAttachment: (id: string, file: { name: string; size: number }) => void;
  removeAttachment: (attachmentId: string) => void;
  // Intimações (Etapa 4)
  getIntimation: (id: string) => Intimation | undefined;
  uploadIntimation: (file: { name: string; demoForceFail?: boolean }) => string | null;
  processIntimation: (id: string, outcome: "success" | "fail", suggestion: IntimationSuggestion | null) => void;
  retryIntimation: (id: string) => void;
  removeIntimation: (id: string) => void;
  confirmIntimationReview: (id: string, review: NewDeadlineInput) => string | null;
  // Notificações (Etapa 4)
  markNotificationRead: (id: string) => void;
  markAllNotificationsRead: () => void;
  // Transferência de prazo pessoal → escritório (Etapa 5)
  transferDeadlineToOffice: (id: string, officeId: string) => void;
  // Reatribuição de responsável no escritório (usada na remoção de membro)
  reassignOpenDeadlines: (officeId: string, fromUserId: string, toUserId: string) => void;
}

const DataContext = createContext<DataApi | null>(null);

function loadStored(): PersistedData | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    // Valida a estrutura completa e descarta registros corrompidos sem quebrar.
    return sanitizeStored(JSON.parse(raw), DATA_VERSION);
  } catch { return null; }
}

export function DataProvider({ children }: { children: ReactNode }) {
  const { user, scope, scopeKind, membership } = useScope();
  const actor = user.id;
  const today = getDemoToday();

  const [data, setData] = useState<PersistedData>(() => emptyData());
  const [hydrated, setHydrated] = useState(false);

  // Hidrata do localStorage após montar. Só habilita a escrita depois de ler,
  // para nunca gravar o estado vazio por cima dos dados salvos.
  useEffect(() => {
    const stored = loadStored();
    if (stored) setData(stored);
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated) return; // aguarda o término da leitura
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(data)); } catch { /* ignora */ }
  }, [data, hydrated]);

  // Conjuntos efetivos = sementes + persistido (persistido vence por id).
  const deadlines = useMemo(() => mergeById(demoDeadlines, data.deadlines), [data.deadlines]);
  const comments = useMemo(() => mergeById(demoComments, data.comments), [data.comments]);
  const attachments = useMemo(() => {
    const merged = mergeById(demoAttachments, data.attachments);
    const removed = new Set(data.removedAttachmentIds);
    return merged.filter((a) => !removed.has(a.id));
  }, [data.attachments, data.removedAttachmentIds]);
  const audit = useMemo(() => mergeById(demoAudit, data.audit), [data.audit]);
  const notifications = useMemo(() => mergeById(demoNotifications, data.notifications), [data.notifications]);
  const intimations = useMemo(() => {
    const merged = mergeById(demoIntimations, data.intimations);
    const removed = new Set(data.removedIntimationIds);
    return merged.filter((i) => !removed.has(i.id));
  }, [data.intimations, data.removedIntimationIds]);

  const getDeadline = useCallback((id: string) => deadlines.find((d) => d.id === id), [deadlines]);
  const getIntimation = useCallback((id: string) => intimations.find((i) => i.id === id), [intimations]);
  const commentsFor = useCallback((id: string) =>
    comments.filter((c) => c.deadlineId === id).sort((a, b) => a.createdAt.localeCompare(b.createdAt)), [comments]);
  const attachmentsFor = useCallback((id: string) => attachments.filter((a) => a.deadlineId === id), [attachments]);
  const historyFor = useCallback((id: string) =>
    audit.filter((h) => h.deadlineId === id).sort((a, b) => a.createdAt.localeCompare(b.createdAt)), [audit]);

  // Contexto de escrita e dependências para as operações puras (data-ops.mjs).
  const ctx = useMemo(() => ({ scope, scopeKind, userId: user.id, membership }), [scope, scopeKind, user.id, membership]);
  const deps = useMemo(() => ({ newId, today }), [today]);
  const seeds = { deadlines: demoDeadlines, attachments: demoAttachments, intimations: demoIntimations, notifications: demoNotifications };

  const createDeadline = useCallback((input: NewDeadlineInput): string | null => {
    const res = opCreateDeadline(data, ctx, input, deps);
    if (res.id === null) return null; // bloqueado por permissão — nada muda
    setData(res.state);
    return res.id;
  }, [data, ctx, deps]);

  const updateDeadline = useCallback((id: string, patch: Partial<Deadline>) =>
    setData((s) => opUpdateDeadline(s, ctx, id, patch, deps, seeds)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ctx, deps]);

  const setStatus = useCallback((id: string, status: Deadline["status"]) =>
    setData((s) => opSetStatus(s, ctx, id, status, deps, seeds)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ctx, deps]);

  const addComment = useCallback((id: string, text: string) =>
    setData((s) => opAddComment(s, ctx, id, text, deps, seeds)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ctx, deps]);

  const addAttachment = useCallback((id: string, file: { name: string; size: number }) =>
    setData((s) => opAddAttachment(s, ctx, id, file, deps, seeds)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ctx, deps]);

  const removeAttachment = useCallback((attachmentId: string) =>
    setData((s) => opRemoveAttachment(s, ctx, attachmentId, deps, seeds)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ctx, deps]);

  const uploadIntimation = useCallback((file: { name: string; demoForceFail?: boolean }): string | null => {
    const res = opUploadIntimation(data, ctx, file, deps);
    if (res.id === null) return null;
    setData(res.state);
    return res.id;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, ctx, deps]);

  const processIntimation = useCallback((id: string, outcome: "success" | "fail", suggestion: IntimationSuggestion | null) =>
    setData((s) => opProcessIntimation(s, ctx, id, outcome, suggestion, deps, seeds)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ctx, deps]);

  const retryIntimation = useCallback((id: string) =>
    setData((s) => opRetryIntimation(s, ctx, id, deps, seeds)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ctx, deps]);

  const removeIntimation = useCallback((id: string) =>
    setData((s) => opRemoveIntimation(s, ctx, id, deps, seeds)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ctx, deps]);

  const confirmIntimationReview = useCallback((id: string, review: NewDeadlineInput): string | null => {
    const res = opConfirmIntimationReview(data, ctx, id, review, deps, seeds);
    setData(res.state);
    return res.deadlineId;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, ctx, deps]);

  const markNotificationRead = useCallback((id: string) =>
    setData((s) => opMarkNotificationRead(s, ctx, id, seeds)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ctx]);

  const markAllNotificationsRead = useCallback(() =>
    setData((s) => opMarkAllNotificationsRead(s, ctx, seeds)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ctx]);

  const transferDeadlineToOffice = useCallback((id: string, officeId: string) =>
    setData((s) => opTransferDeadlineToOffice(s, ctx, id, officeId, deps, seeds)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ctx, deps]);

  const reassignOpenDeadlines = useCallback((officeId: string, fromUserId: string, toUserId: string) =>
    setData((s) => opReassignResponsibleForOffice(s, ctx, officeId, fromUserId, toUserId, deps, seeds)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ctx, deps]);

  const value: DataApi = {
    deadlines, intimations, notifications,
    getDeadline, commentsFor, attachmentsFor, historyFor,
    createDeadline, updateDeadline, setStatus, addComment, addAttachment, removeAttachment,
    getIntimation, uploadIntimation, processIntimation, retryIntimation, removeIntimation, confirmIntimationReview,
    markNotificationRead, markAllNotificationsRead,
    transferDeadlineToOffice,
    reassignOpenDeadlines,
  };

  return <DataContext.Provider value={value}>{children}</DataContext.Provider>;
}

export function useData(): DataApi {
  const ctx = useContext(DataContext);
  if (!ctx) throw new Error("useData deve ser usado dentro de <DataProvider>");
  return ctx;
}
