export type UrgencyLevel = "overdue" | "today" | "soon" | "upcoming";
export type BadgeTone = "danger" | "warning" | "success" | "info" | "neutral" | "teal";
export const SOON_THRESHOLD_DAYS: number;
export function urgencyOf(dueDate: string, today: string): { level: UrgencyLevel; days: number };
export function isUrgent(level: UrgencyLevel): boolean;
export const URGENCY_META: Record<UrgencyLevel, { label: string; tone: BadgeTone }>;
export const URGENCY_ORDER: Record<UrgencyLevel, number>;
