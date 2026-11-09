import type { ApiClient } from "./api-client.d.mts";
import type { PublicUser } from "./dto.d.mts";
export type AuthStatus = "loading" | "anonymous" | "authenticated" | "expired" | "unavailable";
export interface AuthState { status: AuthStatus; user: PublicUser | null; error: string | null; }
export interface AuthController {
  readonly state: AuthState;
  subscribe(l: (s: AuthState) => void): () => void;
  restore(): Promise<void>;
  login(email: string, password: string): Promise<PublicUser>;
  register(name: string, email: string, password: string): Promise<unknown>;
  logout(): Promise<void>;
  sessionEnded(code?: string): void;
  onMessage(msg: unknown): void;
  updateUser(user: PublicUser): void;
}
export function createAuthController(opts: {
  api: ApiClient; channel?: { postMessage(m: unknown): void; onmessage: ((ev: MessageEvent) => void) | null } | null;
  onReset?: () => void;
}): AuthController;
