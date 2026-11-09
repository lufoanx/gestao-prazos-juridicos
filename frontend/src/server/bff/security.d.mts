import type { BffConfig } from "./config.d.mts";
export const CSRF_HEADER: string;
export function checkCsrf(method: string, headers: Headers, config: BffConfig): null | { status: number; code: string; message: string };
export function sessionCookie(config: BffConfig, value: string, maxAgeSeconds: number): string;
export function clearSessionCookie(config: BffConfig): string;
export function readSessionId(cookieHeader: string | null, config: BffConfig): string | null;
export const NO_STORE: Record<string, string>;
