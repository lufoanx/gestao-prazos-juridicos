export const RECOVERY_TEXT: Readonly<Record<
  | "accepted" | "acceptedNote" | "disabled" | "statusError" | "forgotUnknown" | "unavailable" | "generic"
  | "missingLink" | "invalidLink" | "passwordRejected" | "mismatch" | "concurrent" | "resetUnknown" | "success" | "memoryOnly"
  | "waitingPrevious" | "replaced",
  string>>;
export function parseRetryAfter(value: unknown): number | null;
export function rateLimitText(retryAfter: number | null | undefined): string;

export type ForgotPhase = "checking" | "disabled" | "status_error" | "form" | "sending" | "accepted" | "rate_limited" | "unknown";
export interface ForgotState { phase: ForgotPhase; error?: string; field?: "email"; retryAfter?: number | null; waiting?: boolean }
export type ForgotAction =
  | { type: "check" } | { type: "status"; available: boolean } | { type: "status_failed" }
  | { type: "submit" } | { type: "invalid"; error: string; field?: "email" } | { type: "accepted" }
  | { type: "failed"; outcome: Omit<ForgotState, "waiting"> } | { type: "edit" } | { type: "cooldown"; waiting: boolean };
export const FORGOT_INITIAL: ForgotState;
export function forgotReducer(state: ForgotState, action: ForgotAction): ForgotState;
export function classifyForgotError(e: unknown): Omit<ForgotState, "waiting">;
export function checkForgotForm(email: string): { email?: string };

export type ResetPhase = "reading" | "missing" | "form" | "sending" | "waiting_previous" | "success" | "invalid_link" | "rate_limited" | "unknown";
export interface ResetState {
  phase: ResetPhase; error?: string; field?: "password" | "confirm"; retryAfter?: number | null; waiting?: boolean;
  hasToken?: boolean; notice?: "replaced";
}
export interface ResetOutcome { phase: ResetPhase; error?: string; field?: "password"; retryAfter?: number | null; dropToken?: boolean }
export type ResetAction =
  | { type: "captured"; hasToken: boolean } | { type: "submit" } | { type: "invalid"; error: string; field?: "password" | "confirm" }
  | { type: "success" } | { type: "failed"; outcome: ResetOutcome } | { type: "edit" } | { type: "cooldown"; waiting: boolean }
  | { type: "settled_stale" };
export const RESET_INITIAL: ResetState;
export function resetReducer(state: ResetState, action: ResetAction): ResetState;
export function classifyResetError(e: unknown): ResetOutcome;
export function checkResetForm(values: { password: string; confirm: string }): { password?: string; confirm?: string };

export interface SingleFlight {
  readonly busy: boolean;
  run<T>(fn: () => Promise<T>): Promise<{ started: false } | { started: true; value?: T; error?: unknown }>;
}
export function createSingleFlight(): SingleFlight;
