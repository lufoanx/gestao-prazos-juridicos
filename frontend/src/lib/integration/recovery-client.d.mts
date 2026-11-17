import type { ApiClient } from "./api-client.mjs";
export const RECOVERY_PATHS: Readonly<{ status: string; forgot: string; reset: string }>;
export interface RecoveryClient {
  status(): Promise<{ available: boolean }>;
  forgot(email: string): Promise<unknown>;
  reset(token: string, newPassword: string): Promise<unknown>;
}
export function createRecoveryClient(opts?: { api?: ApiClient }): RecoveryClient;
