import type { ApiClient } from "./api-client.d.mts";
import type * as D from "./dto.d.mts";
export const INTIMATION_LIST_PARAMS: readonly string[];
export interface IntimationListParams { scope: "personal" | "office"; status?: D.IntimationStatus | ""; q?: string; page?: number; perPage?: number }
export interface IntimationsClient {
  list(p: IntimationListParams): Promise<D.IntimationPage>;
  register(scope: "personal" | "office", meta: D.RegisterIntimation): Promise<D.Intimation>;
  get(id: string): Promise<D.Intimation>;
  updateDraft(id: string, version: number, changes: Record<string, unknown>): Promise<D.Intimation>;
  confirm(id: string, version: number, data: Omit<D.DeadlineInput, "reviewed">): Promise<D.ConfirmResult>;
  discard(id: string, version: number): Promise<D.Intimation>;
  history(id: string, page?: number, perPage?: number): Promise<D.IntimationEventPage>;
}
export interface NotificationsClient {
  list(p: { scope: "personal" | "office"; unreadOnly?: boolean; page?: number; perPage?: number }): Promise<D.NotificationPage>;
  unreadCount(scope: "personal" | "office"): Promise<{ unread: number }>;
  markRead(id: string): Promise<D.InboxNotification>;
  readAll(scope: "personal" | "office"): Promise<{ marked: number }>;
}
export function createIntimationsClient(api: ApiClient): IntimationsClient;
export function createNotificationsClient(api: ApiClient): NotificationsClient;
export function notificationHref(n: { resourceType: string; resourceId: string }): string | null;
