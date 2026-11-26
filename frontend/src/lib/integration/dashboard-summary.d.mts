import type { Deadline, DeadlinePage } from "./dto.d.mts";
import type { ListParams } from "./deadlines-client.mjs";

export const URGENT_PER_GROUP: number;
export const AGENDA_LIMIT: number;
export const REVIEW_LIMIT: number;

export interface DashboardOverview {
  overdue: number; dueToday: number; soon: number; open: number; completed: number; total: number;
}
export interface IntegratedDashboardData {
  referenceDate: string;
  consistent: boolean;
  urgent: Deadline[];
  urgentTotal: number;
  urgentHidden: number;
  agenda: Deadline[];
  agendaHidden: number;
  overview: DashboardOverview;
}
export interface DashboardPages {
  overdue: DeadlinePage; today: DeadlinePage; soon: DeadlinePage;
  open: DeadlinePage; completed: DeadlinePage; all: DeadlinePage;
}

export function dashboardQueries(scope: "personal" | "office"): Record<keyof DashboardPages, ListParams>;
export function dashboardResourceKey(scope: "personal" | "office"): string;
export function fetchDashboard(
  client: { list: (params: ListParams) => Promise<DeadlinePage> }, scope: "personal" | "office",
): Promise<IntegratedDashboardData>;
export function summarizeDashboard(pages: DashboardPages): IntegratedDashboardData;
