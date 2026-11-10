import type { ApiClient } from "./api-client.d.mts";
import type * as D from "./dto.d.mts";
export const LIST_PARAMS: readonly string[];
export const CALENDAR_PARAMS: readonly string[];
export function canonicalQuery(params: Record<string, unknown>, names: readonly string[]): string;
export interface ListParams {
  scope: "personal" | "office"; q?: string; status?: D.DeadlineStatus | ""; urgency?: D.UrgencyLevel | ""; area?: string;
  responsibleId?: string; dueFrom?: string; dueTo?: string; sort?: "dueDate" | "title" | "priority" | "status" | "createdAt";
  dir?: "asc" | "desc"; page?: number; perPage?: number;
}
export interface CalendarParams { scope: "personal" | "office"; year: number; month: number; status?: D.DeadlineStatus | ""; page?: number; perPage?: number; }
export interface DeadlinesClient {
  list(p: ListParams): Promise<D.DeadlinePage>;
  create(scope: "personal" | "office", input: D.DeadlineInput): Promise<D.Deadline>;
  get(id: string): Promise<D.Deadline>;
  update(id: string, version: number, changes: Partial<D.DeadlineInput>): Promise<D.Deadline>;
  setStatus(id: string, version: number, status: D.DeadlineStatus, responsibleId?: string): Promise<D.Deadline>;
  transfer(id: string, version: number, officeId: string, opts?: { shareLinkedIntimation?: boolean }): Promise<{ deadline: D.Deadline; notice: string }>;
  comments(id: string, page?: number, perPage?: number): Promise<D.CommentPage>;
  addComment(id: string, text: string): Promise<D.DeadlineComment>;
  history(id: string, page?: number, perPage?: number): Promise<D.HistoryPage>;
  calendar(p: CalendarParams): Promise<D.CalendarPage>;
}
export function createDeadlinesClient(api: ApiClient): DeadlinesClient;
export function fetchWholeMonth(client: DeadlinesClient, p: Omit<CalendarParams, "page">, opts?: { onPage?: (page: number, pageCount: number) => void; maxPages?: number }): Promise<D.CalendarPage & { complete: boolean }>;
