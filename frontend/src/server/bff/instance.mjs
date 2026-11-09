// Instância única do BFF por processo Node (sobrevive ao recarregamento de módulos do dev).
import { loadBffConfig } from "./config.mjs";
import { createBff } from "./manager.mjs";
import { createMemorySessionStore } from "./session-store.mjs";
import { NO_STORE } from "./security.mjs";
import { isIntegratedMode } from "../../lib/integration/mode.mjs";

const KEY = Symbol.for("prazoai.bff.instance");

export function getBff(env = process.env) {
  if (!isIntegratedMode(env)) return null; // modo demonstração: BFF desligado
  const g = globalThis;
  if (!g[KEY]) {
    const config = loadBffConfig(env);
    const store = createMemorySessionStore(config.session);
    g[KEY] = createBff({ config, store, logger: { info: (msg) => console.info(msg) } });
  }
  return g[KEY];
}

export function unavailableResponse() {
  return new Response(JSON.stringify({ error: { code: "not_found", message: "Recurso não encontrado." } }), {
    status: 404, headers: { ...NO_STORE, "content-type": "application/json; charset=utf-8" },
  });
}

export function misconfiguredResponse() {
  return new Response(JSON.stringify({ error: { code: "bff_misconfigured", message: "Integração não configurada." } }), {
    status: 500, headers: { ...NO_STORE, "content-type": "application/json; charset=utf-8" },
  });
}

/** Executa um handler do BFF com tratamento seguro (sem detalhes internos na resposta). */
export async function runBff(handler) {
  let bff;
  try {
    bff = getBff();
  } catch (e) {
    console.error("bff_config_error", e instanceof Error ? e.message : "erro");
    return misconfiguredResponse();
  }
  if (!bff) return unavailableResponse();
  try {
    return await handler(bff);
  } catch {
    console.error("bff_unexpected_error");
    return new Response(JSON.stringify({ error: { code: "internal_error", message: "Erro interno." } }), {
      status: 500, headers: { ...NO_STORE, "content-type": "application/json; charset=utf-8" },
    });
  }
}
