import type { Deadline, Intimation } from "@/types/domain";
import type { UrgencyLevel } from "./urgency.mjs";
export type AnnotatedDeadline = Deadline & { urgency: { level: UrgencyLevel; days: number } };
export interface DashboardOverview {
  total: number; open: number; completed: number;
  overdue: number; dueToday: number; soon: number; urgent: number; awaitingReview: number;
}
export interface DashboardData {
  urgent: AnnotatedDeadline[];
  agenda: AnnotatedDeadline[];
  reviews: Intimation[];
  overview: DashboardOverview;
}
export function buildDashboard(deadlines: Deadline[], intimations: Intimation[], today: string): DashboardData;
