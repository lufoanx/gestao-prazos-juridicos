export interface BffConfig {
  appEnv: "development" | "test" | "staging" | "production";
  hosted: boolean;
  appOrigin: string;
  backendBase: string;
  cookie: { name: string; secure: boolean; sameSite: "Strict"; path: "/" };
  session: {
    maxSessions: number; idleSeconds: number; maxAgeSeconds: number;
    sweepIntervalSeconds: number; refreshSkewSeconds: number;
  };
  timeoutMs: number;
  maxBodyBytes: number;
  files: { maxBytes: number; timeoutMs: number };
  proxySecret: string;
  clientIpHeader: string;
  clientIpSource: "none" | "header" | "x-forwarded-for-rightmost";
  sessionStore: { kind: "memory" | "postgres"; target: string | null; poolMax: number };
}
export class BffConfigError extends Error {}
export function loadBffConfig(env?: Record<string, string | undefined>): BffConfig;
