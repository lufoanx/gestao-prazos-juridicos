// Configuração do BFF (somente servidor). NUNCA importar em componentes de cliente.
//
// Ambiente da APLICAÇÃO (PRAZOAI_APP_ENV) é separado de NODE_ENV: `next build && next start`
// roda com NODE_ENV=production também em testes; a segurança dos cookies depende de
// PRAZOAI_APP_ENV + origem configurada, nunca de Host ou X-Forwarded-Proto da requisição.

import { parseSessionKey } from "./session-crypto.mjs";

const APP_ENVS = new Set(["development", "test", "staging", "production"]);
/** Ambientes HOSPEDADOS (homologação e produção): mesmas exigências; contas reais só em production. */
const HOSTED = new Set(["staging", "production"]);
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);
const STORES = new Set(["memory", "postgres"]);
const TLS_SSLMODES = new Set(["require", "verify-ca", "verify-full"]);

export class BffConfigError extends Error {}

/** URL do PostgreSQL das sessões do BFF. Mensagens nunca contêm o valor (pode ter senha). */
function parseSessionDatabaseUrl(raw, hosted) {
  if (!raw) throw new BffConfigError("PRAZOAI_BFF_DATABASE_URL é obrigatória com PRAZOAI_BFF_SESSION_STORE=postgres.");
  let u;
  try { u = new URL(raw); } catch { throw new BffConfigError("PRAZOAI_BFF_DATABASE_URL inválida."); }
  if (!["postgres:", "postgresql:"].includes(u.protocol)) throw new BffConfigError("PRAZOAI_BFF_DATABASE_URL deve usar postgresql://.");
  if (!u.hostname) throw new BffConfigError("PRAZOAI_BFF_DATABASE_URL precisa indicar o host.");
  if (!u.pathname || u.pathname === "/") throw new BffConfigError("PRAZOAI_BFF_DATABASE_URL precisa indicar o banco.");
  for (const k of ["options", "host", "hostaddr", "service"]) {
    if (u.searchParams.has(k)) throw new BffConfigError(`PRAZOAI_BFF_DATABASE_URL não pode definir '${k}'.`);
  }
  if (hosted && !TLS_SSLMODES.has(u.searchParams.get("sslmode") || "")) {
    throw new BffConfigError("PRAZOAI_BFF_DATABASE_URL exige sslmode=require|verify-ca|verify-full em ambiente hospedado.");
  }
  return { url: raw, target: `${u.hostname}:${u.port || 5432}${u.pathname}` };
}

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
  if (!APP_ENVS.has(appEnv)) throw new Error("PRAZOAI_APP_ENV inválido (development|test|staging|production).");
  const hosted = HOSTED.has(appEnv);

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
    if (hosted) throw new Error(`Cookies sem Secure não são permitidos em PRAZOAI_APP_ENV=${appEnv}.`);
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

  // ---- requisitos de ambiente HOSPEDADO (homologação e produção): falha ao iniciar se faltar algo ----
  const privateBackend = env.PRAZOAI_BACKEND_PRIVATE_NETWORK === "true";
  if (env.PRAZOAI_BACKEND_PRIVATE_NETWORK && !["true", "false"].includes(env.PRAZOAI_BACKEND_PRIVATE_NETWORK)) {
    throw new Error("PRAZOAI_BACKEND_PRIVATE_NETWORK deve ser true ou false.");
  }
  if (hosted) {
    if (isLoopback) throw new Error(`PRAZOAI_APP_ORIGIN não pode ser loopback em PRAZOAI_APP_ENV=${appEnv}.`);
    if (!proxySecret || !clientIpHeader) {
      throw new Error("Ambiente hospedado exige PRAZOAI_PROXY_SECRET e PRAZOAI_TRUSTED_CLIENT_IP_HEADER "
        + "(sem eles os limites por IP do backend ficam compartilhados entre todos os visitantes).");
    }
    if (backend.protocol !== "https:" && !privateBackend) {
      throw new Error("PRAZOAI_BACKEND_URL exige https em ambiente hospedado, salvo rede privada declarada "
        + "(PRAZOAI_BACKEND_PRIVATE_NETWORK=true).");
    }
  }

  // ---- armazenamento das sessões ----
  const storeKind = (env.PRAZOAI_BFF_SESSION_STORE || (hosted ? "" : "memory")).trim();
  if (!STORES.has(storeKind)) {
    throw new Error(hosted
      ? "PRAZOAI_BFF_SESSION_STORE=postgres é obrigatório em ambiente hospedado."
      : "PRAZOAI_BFF_SESSION_STORE inválido (memory|postgres).");
  }
  if (hosted && storeKind !== "postgres") {
    throw new Error(`Sessões em memória não são permitidas em PRAZOAI_APP_ENV=${appEnv}: use PRAZOAI_BFF_SESSION_STORE=postgres.`);
  }
  let storeSecrets = null;
  let storeTarget = null;
  if (storeKind === "postgres") {
    const db = parseSessionDatabaseUrl(env.PRAZOAI_BFF_DATABASE_URL, hosted);
    const current = parseSessionKey(env.PRAZOAI_BFF_SESSION_KEY, "PRAZOAI_BFF_SESSION_KEY");
    const previous = env.PRAZOAI_BFF_SESSION_KEY_PREVIOUS
      ? parseSessionKey(env.PRAZOAI_BFF_SESSION_KEY_PREVIOUS, "PRAZOAI_BFF_SESSION_KEY_PREVIOUS") : null;
    if (previous && previous.equals(current)) throw new Error("PRAZOAI_BFF_SESSION_KEY_PREVIOUS igual à chave atual.");
    storeSecrets = Object.freeze({ databaseUrl: db.url, keys: Object.freeze({ current, previous }) });
    storeTarget = db.target;
  }

  const config = {
    appEnv,
    hosted,
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
    // Doc 28: SÓ as rotas de arquivo de intimação aceitam corpo maior (PDF ≤ 10 MiB, igual ao backend).
    files: Object.freeze({
      maxBytes: 10 * 1024 * 1024,
      timeoutMs: int(env, "PRAZOAI_BFF_FILE_TIMEOUT_MS", 60000, 1000, 300000),
    }),
    proxySecret,
    clientIpHeader,
    sessionStore: Object.freeze({
      kind: storeKind,
      target: storeTarget,                         // host:porta/banco, sem credenciais
      poolMax: int(env, "PRAZOAI_BFF_DATABASE_POOL_MAX", 5, 1, 50),
    }),
  };
  // Segredos do armazenamento: propriedade NÃO enumerável (não aparece em JSON.stringify nem em logs).
  Object.defineProperty(config, "sessionStoreSecrets", { value: storeSecrets, enumerable: false });
  return Object.freeze(config);
}
