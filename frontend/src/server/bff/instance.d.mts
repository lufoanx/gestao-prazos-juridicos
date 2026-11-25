import type { BffConfig } from "./config.d.mts";

export interface Bff {
  register(r: Request): Promise<Response>;
  login(r: Request): Promise<Response>;
  logout(r: Request): Promise<Response>;
  session(r: Request): Promise<Response>;
  proxy(r: Request, path: string): Promise<Response>;
  publicInvitationLookup(r: Request): Promise<Response>;
  passwordStatus(r: Request): Promise<Response>;
  passwordForgot(r: Request): Promise<Response>;
  passwordReset(r: Request): Promise<Response>;
  store: { kind: string; ping(): Promise<boolean>; close(): Promise<void> };
  config: BffConfig;
}
export function getBff(env?: Record<string, string | undefined>): Promise<Bff> | null;
export function createSessionStore(config: BffConfig, opts?: { now?: () => number }): Promise<unknown>;
export function runBff(handler: (bff: Bff) => Promise<Response>): Promise<Response>;
export function healthResponse(): Promise<Response>;
export function unavailableResponse(): Response;
export function misconfiguredResponse(): Response;
