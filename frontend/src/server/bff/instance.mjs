// Instância única do BFF por processo Node (sobrevive ao recarregamento de módulos do dev).
// O armazenamento das sessões vem da configuração: memória (desenvolvimento/testes) ou PostgreSQL
// compartilhado (obrigatório em homologação e produção; várias instâncias do BFF).
import { loadBffConfig } from "./config.mjs";
import { createBff } from "./manager.mjs";
import { SessionCapacityError, SessionStoreUnavailableError, createMemorySessionStore } from "./session-store.mjs";
import { SessionSchemaError } from "./session-schema.mjs";
import { NO_STORE } from "./security.mjs";
import { isIntegratedMode } from "../../lib/integration/mode.mjs";

const KEY = Symbol.for("prazoai.bff.instance");
const logger = {
  info: (msg) => console.info(msg),
  error: (msg, fields) => console.error(msg, fields?.code ?? ""),
};

export async function createSessionStore(config, { now } = {}) {
  if (config.sessionStore.kind === "memory") return createMemorySessionStore(config.session, now);
  const { createPgSessionStore, createSessionPool } = await import("./session-store-pg.mjs");
  const { createSessionCipher } = await import("./session-crypto.mjs");
  const secrets = config.sessionStoreSecrets;
  const pool = createSessionPool({ databaseUrl: secrets.databaseUrl, poolMax: config.sessionStore.poolMax });
  return createPgSessionStore({ pool, limits: config.session, cipher: createSessionCipher(secrets.keys), now, logger });
}

/** Instância do processo (Promise), ou null no modo demonstração (BFF desligado). */
export function getBff(env = process.env) {
  if (!isIntegratedMode(env)) return null;
  const g = globalThis;
  if (!g[KEY]) {
    g[KEY] = (async () => {
      const config = loadBffConfig(env);
      const store = await createSessionStore(config);
      const bff = createBff({ config, store, logger });
      console.info("bff_ready", JSON.stringify({ appEnv: config.appEnv, sessionStore: config.sessionStore.kind }));
      return { ...bff, store, config };
    })().catch((e) => { delete g[KEY]; throw e; });
  }
  return g[KEY];
}

function jsonError(status, code, message) {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status, headers: { ...NO_STORE, "content-type": "application/json; charset=utf-8" },
  });
}

export function unavailableResponse() {
  return jsonError(404, "not_found", "Recurso não encontrado.");
}

export function misconfiguredResponse() {
  return jsonError(500, "bff_misconfigured", "Integração não configurada.");
}

/** Executa um handler do BFF com tratamento seguro (sem detalhes internos na resposta). */
export async function runBff(handler) {
  let bff;
  try {
    bff = await getBff();
  } catch (e) {
    console.error("bff_config_error", e instanceof Error ? e.message : "erro");
    return misconfiguredResponse();
  }
  if (!bff) return unavailableResponse();
  try {
    return await handler(bff);
  } catch (e) {
    if (e instanceof SessionStoreUnavailableError) {
      console.error("bff_session_store_unavailable");
      return jsonError(503, "session_store_unavailable", "Serviço indisponível. Tente novamente.");
    }
    if (e instanceof SessionSchemaError) {
      console.error("bff_session_schema_error", e.message);
      return misconfiguredResponse();
    }
    if (e instanceof SessionCapacityError) {
      return jsonError(503, "session_capacity_reached", "Muitas sessões ativas no momento. Tente novamente mais tarde.");
    }
    console.error("bff_unexpected_error");
    return jsonError(500, "internal_error", "Erro interno.");
  }
}

/**
 * Disponibilidade do BFF para o balanceador/plataforma: configuração carregada e armazenamento de
 * sessões acessível (no PostgreSQL: conexão e versão do esquema). Não consulta o backend (que tem
 * seu próprio health check) e não expõe destinos, versões ou contagens.
 */
export async function healthResponse() {
  let bff;
  try {
    bff = await getBff();
  } catch {
    return jsonError(503, "bff_misconfigured", "Integração não configurada.");
  }
  if (!bff) return unavailableResponse();
  try {
    await bff.store.ping();
  } catch {
    return jsonError(503, "session_store_unavailable", "Armazenamento de sessões indisponível.");
  }
  return new Response(JSON.stringify({ status: "ok", sessionStore: bff.config.sessionStore.kind }), {
    status: 200, headers: { ...NO_STORE, "content-type": "application/json; charset=utf-8" },
  });
}
