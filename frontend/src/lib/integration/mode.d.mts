export type AppMode = "demo" | "integrated";
export const MODES: readonly AppMode[];
export function resolveMode(value: string | undefined): AppMode;
export function isIntegratedMode(env?: Record<string, string | undefined>): boolean;
export const APP_MODE: AppMode;
