export interface BffConfig {
  appEnv: "development" | "test" | "production";
  appOrigin: string;
  backendBase: string;
  cookie: { name: string; secure: boolean; sameSite: "Strict"; path: "/" };
  session: {
    maxSessions: number; idleSeconds: number; maxAgeSeconds: number;
    sweepIntervalSeconds: number; refreshSkewSeconds: number; logoutMemorySeconds: number;
  };
  timeoutMs: number;
  maxBodyBytes: number;
  proxySecret: string;
  clientIpHeader: string;
}
export function loadBffConfig(env?: Record<string, string | undefined>): BffConfig;
