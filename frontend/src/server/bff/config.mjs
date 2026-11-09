// Configuração do BFF (somente servidor). NUNCA importar em componentes de cliente.
//
// Ambiente da APLICAÇÃO (PRAZOAI_APP_ENV) é separado de NODE_ENV: `next build && next start`
// roda com NODE_ENV=production também em testes; a segurança dos cookies depende de
// PRAZOAI_APP_ENV + origem configurada, nunca de Host ou X-Forwarded-Proto da requisição.

const APP_ENVS = new Set(["development", "test", "production"]);
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

function int(env, name, def, min, max) {
  const raw = env[name];
  if (raw === undefined || raw === "") return def;
  if (!/^-?\d+$/.test(String(raw))) throw new Error(`${name} deve ser inteiro.`);
  const v = Number(raw);
  if (v < min || v > max) throw new Error(`${name} deve estar entre ${min} e ${max}.`);
  return v;
}

/** @returns {import("./config.d.mts").BffConfig} */
export function loadBffConfig(env = process.env) {
  const appEnv = env.PRAZOAI_APP_ENV || "production";
  if (!APP_ENVS.has(appEnv)) throw new Error("PRAZOAI_APP_ENV inválido (development|test|production).");

  const originRaw = env.PRAZOAI_APP_ORIGIN;
  if (!originRaw) throw new Error("PRAZOAI_APP_ORIGIN é obrigatório (ex.: https://app.exemplo.com).");
  let origin;
  try { origin = new URL(originRaw); } catch { throw new Error("PRAZOAI_APP_ORIGIN inválido."); }
  if (origin.origin !== originRaw.replace(/\/$/, "")) throw new Error("PRAZOAI_APP_ORIGIN deve ser só a origem.");
  if (!["http:", "https:"].includes(origin.protocol)) throw new Error("PRAZOAI_APP_ORIGIN deve ser http(s).");

  const insecureRequested = env.PRAZOAI_COOKIE_INSECURE_LOCAL === "true";
  const isLoopback = LOOPBACK.has(origin.hostname);
  if (origin.protocol === "http:") {
    if (!insecureRequested) throw new Error("Origem HTTP exige PRAZOAI_COOKIE_INSECURE_LOCAL=true (só local).");
    if (appEnv === "production") throw new Error("Cookies sem Secure não são permitidos em PRAZOAI_APP_ENV=production.");
    if (!isLoopback) throw new Error("Cookies sem Secure só em origem loopback (localhost/127.0.0.1/[::1]).");
  } else if (insecureRequested) {
    throw new Error("PRAZOAI_COOKIE_INSECURE_LOCAL só é aceito com origem HTTP loopback.");
  }
  const secure = origin.protocol === "https:";

  const backendRaw = env.PRAZOAI_BACKEND_URL || "http://127.0.0.1:8000";
  let backend;
  try { backend = new URL(backendRaw); } catch { throw new Error("PRAZOAI_BACKEND_URL inválido."); }
  if (!["http:", "https:"].includes(backend.protocol) || backend.username || backend.password
      || backend.search || backend.hash) throw new Error("PRAZOAI_BACKEND_URL inválido.");

  const accessTtlHint = int(env, "PRAZOAI_ACCESS_REFRESH_SKEW_SECONDS", 30, 0, 3500);
  const proxySecret = env.PRAZOAI_PROXY_SECRET || "";
  if (proxySecret && Buffer.byteLength(proxySecret, "utf8") < 32) throw new Error("PRAZOAI_PROXY_SECRET curto (mín. 32 bytes).");
  const clientIpHeader = (env.PRAZOAI_TRUSTED_CLIENT_IP_HEADER || "").trim().toLowerCase();
  if (clientIpHeader && !proxySecret) throw new Error("PRAZOAI_TRUSTED_CLIENT_IP_HEADER exige PRAZOAI_PROXY_SECRET.");
  if (clientIpHeader && !/^[a-z0-9-]{1,64}$/.test(clientIpHeader)) throw new Error("PRAZOAI_TRUSTED_CLIENT_IP_HEADER inválido.");
  if (["x-forwarded-for", "forwarded"].includes(clientIpHeader)) {
    throw new Error("Use um cabeçalho sobrescrito pela infraestrutura, não X-Forwarded-For/Forwarded.");
  }

  return Object.freeze({
    appEnv,
    appOrigin: origin.origin,
    backendBase: backend.origin + backend.pathname.replace(/\/$/, ""),
    cookie: Object.freeze({
      name: secure ? "__Host-prazoai_sid" : "prazoai_sid",
      secure,
      sameSite: "Strict",
      path: "/",
    }),
    session: Object.freeze({
      maxSessions: int(env, "PRAZOAI_BFF_MAX_SESSIONS", 1000, 1, 100000),
      idleSeconds: int(env, "PRAZOAI_BFF_SESSION_IDLE_SECONDS", 8 * 3600, 60, 7 * 24 * 3600),
      maxAgeSeconds: int(env, "PRAZOAI_BFF_SESSION_MAX_AGE_SECONDS", 7 * 24 * 3600, 300, 30 * 24 * 3600),
      sweepIntervalSeconds: int(env, "PRAZOAI_BFF_SWEEP_INTERVAL_SECONDS", 60, 1, 3600),
      refreshSkewSeconds: accessTtlHint,
    }),
    timeoutMs: int(env, "PRAZOAI_BFF_TIMEOUT_MS", 10000, 100, 60000),
    maxBodyBytes: int(env, "PRAZOAI_BFF_MAX_BODY_BYTES", 64 * 1024, 1024, 1024 * 1024),
    proxySecret,
    clientIpHeader,
  });
}
