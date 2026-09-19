import { demoNotifications } from "@/mocks/data";
import type { Notification, Scope } from "@/types/domain";

function sameScope(a: Scope, b: Scope) {
  return a.kind === b.kind && (
    a.kind === "personal" && b.kind === "personal" ? a.ownerId === b.ownerId :
    a.kind === "office" && b.kind === "office" && a.officeId === b.officeId
  );
}

export interface NotificationService {
  list(scope: Scope): Promise<Notification[]>;
  unreadCount(scope: Scope): Promise<number>;
}

export const mockNotificationService: NotificationService = {
  async list(scope) { return structuredClone(demoNotifications.filter((n) => sameScope(n.scope, scope))); },
  async unreadCount(scope) { return (await this.list(scope)).filter((n) => !n.read).length; },
};
