export const CSRF_HEADER: string;
export type ApiErrorCategory =
  | "network" | "session" | "forbidden" | "not_found" | "conflict" | "validation"
  | "rate_limited" | "unknown_outcome" | "unavailable" | "error";
export class ApiError extends Error {
  status: number; code: string; retryAfter: string | null; outcome: string | null;
  constructor(status: number, code: string, message: string, extra?: { retryAfter?: string | null; outcome?: string | null });
  get category(): ApiErrorCategory;
}
export class StaleResponseError extends Error {}
export interface ApiClient {
  request<T = unknown>(method: string, path: string, body?: unknown): Promise<T>;
  readonly epoch: number;
  bumpEpoch(): void;
}
export function createApiClient(opts?: { fetchImpl?: typeof fetch; base?: string }): ApiClient;
