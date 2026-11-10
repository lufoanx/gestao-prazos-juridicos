export function parseInviteFragment(hash: string): string | null;
export function buildInviteLink(origin: string, token: string): string;
export function captureInviteToken(win: { location: { hash: string; pathname: string }; history: { replaceState(a: unknown, b: string, c: string): void } }): string | null;
export const INVITE_STATES: Readonly<Record<"valid" | "expired" | "revoked" | "used" | "invalid", string>>;
