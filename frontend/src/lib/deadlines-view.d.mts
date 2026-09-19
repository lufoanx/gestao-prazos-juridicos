import type { Deadline, Scope } from "@/types/domain";

export interface FilterOpts {
  query?: string;
  status?: "all" | "open" | "completed" | "cancelled";
  urgency?: "all" | "overdue" | "today" | "soon" | "upcoming";
  area?: string;
  today: string;
}
export interface Page<T> { items: T[]; page: number; pageCount: number; total: number; }

export function matchesScope(d: Deadline, scope: Scope): boolean;
export function filterDeadlines(list: Deadline[], opts?: FilterOpts): Deadline[];
export function sortDeadlines(list: Deadline[], key?: string, dir?: "asc" | "desc"): Deadline[];
export function paginate<T>(list: T[], page?: number, perPage?: number): Page<T>;
export function distinctAreas(list: Deadline[]): string[];
export function monthMatrix(year: number, month1: number): string[][];
export function groupByDueDate(list: Deadline[]): Record<string, Deadline[]>;
