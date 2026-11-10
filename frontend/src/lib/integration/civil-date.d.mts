export function isCivilDate(v: unknown): boolean;
export function formatCivilDate(v: string | null | undefined): string;
export function parts(v: string): { year: number; month: number; day: number } | null;
export function civil(year: number, month: number, day: number): string;
export function addMonths(year: number, month: number, delta: number): { year: number; month: number };
export function monthGrid(year: number, month: number): Array<Array<string | null>>;
export const MONTH_NAMES: readonly string[];
