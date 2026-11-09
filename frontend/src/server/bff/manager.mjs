// Núcleo do BFF: cadastro, login, sessão, logout, renovação serializada e proxy restrito.
//
// Regras:
// - o navegador só recebe o identificador opaco da sessão; NENHUM token sai em JSON, cabeçalho
//   ou log;
// - renovação ANTES do envio quando o access token está perto de expirar; serializada pela
//   sessão (requisições concorrentes aguardam a mesma promessa e usam o estado atualizado);
// - uma renovação que termine depois do logout/troca de usuário não recria a sessão
//   (troca condicional por geração);
// - erros distintos: sessão inválida (401 + limpeza), backend indisponível (503), limite (429 com
//   Retry-After), resultado incerto da renovação (sessão local invalidada, novo login);
// - mutações nunca são repetidas automaticamente; após 401 do backend não há nova tentativa.
import { isIP } from "node:net";
import { callBackend } from "./backend-client.mjs";
import { matchAllowlist } from "./allowlist.mjs";
import { CSRF_HEADER, NO_STORE, checkCsrf, clearSessionCookie, readSessionId, sessionCookie } from "./security.mjs";
import { SessionCapacityError } from "./session-store.mjs";

const PASS_HEADERS = ["retry-after", "x-current-version"];

function json(status, body, extra = {}) {
  const headers = new Headers({ ...NO_STORE, "content-type": "application/json; charset=utf-8" });
  for (const [k, v] of Object.entries(extra)) {
    if (k === "set-cookie") headers.append("set-cookie", v);
    else headers.set(k, v);
  }
  return new Response(body === null ? null : JSON.stringify(body), { status, headers });
}

const err = (status, code, message, extra) => json(status, { error: { code, message } }, extra);

export function createBff({ config, store, fetchImpl = fetch, logger = console, now = () => Date.now() }) {
  const ctx = { config, fetchImpl };
  const log = (event, fields = {}) => logger.info?.(`bff_${event}`, fields); // nunca tokens ou ids de sessão

  function clientIp(request) {
    if (!config.clientIpHeader) return undefined;
    const value = (request.headers.get(config.clientIpHeader) || "").trim();
    return isIP(value) ? value : undefined;
  }

  async function readJson(request) {
    const declared = Number(request.headers.get("content-length") || "0");
    if (declared > config.maxBodyBytes) return { error: err(413, "payload_too_large", "Corpo muito grande.") };
    if (!request.body) return { value: undefined };
    const reader = request.body.getReader();
    const chunks = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > config.maxBodyBytes) {
        await reader.cancel();
        return { error: err(413, "payload_too_large", "Corpo muito grande.") };
      }
      chunks.push(value);
    }
    if (size === 0) return { value: undefined };
    try {
      const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        return { error: err(422, "validation_error", "Corpo JSON deve ser um objeto.") };
      }
      return { value: parsed };
    } catch {
      return { error: err(422, "validation_error", "JSON inválido.") };
    }
  }

  function passthrough(result) {
    const extra = {};
    for (const h of PASS_HEADERS) {
      const v = result.headers.get(h);
      if (v) extra[h] = v;
    }
    const body = result.json && typeof result.json === "object" ? result.json : null;
    if (result.status === 204) return json(204, null, extra);
    if (result.status >= 500) return err(503, "backend_unavailable", "Serviço indisponível. Tente novamente.");
    return json(result.status, body ?? { error: { code: "upstream_error", message: "Resposta inválida." } }, extra);
  }

  function ended(code, message) {
    return err(401, code, message, { "set-cookie": clearSessionCookie(config) });
  }

  function guard(request) {
    return checkCsrf(request.method, request.headers, config);
  }

  // ------------------------------------------------------------------ renovação
  async function ensureFresh(sessionId) {
    let s = store.get(sessionId);
    if (!s) return { state: "invalid", code: "session_expired" };
    const skewMs = config.session.refreshSkewSeconds * 1000;
    if (s.accessExpiresAt - skewMs > now()) return { state: "ok", session: s };
    if (s.refreshing) {
      const outcome = await s.refreshing;
      if (outcome.state !== "ok") return outcome;
      s = store.get(sessionId);
      return s ? { state: "ok", session: s } : { state: "invalid", code: "session_expired" };
    }
    const generation = s.generation;
    const refreshToken = s.refreshToken;
    const promise = (async () => {
      const r = await callBackend(ctx, { method: "POST", path: "/auth/refresh", body: { refreshToken } });
      if (r.kind === "unreachable") return { state: "unavailable" };
      if (r.kind === "uncertain") {
        // Pode ter havido rotação: o refresh antigo NÃO é repetido; exige novo login.
        store.delete(sessionId);
        log("refresh_uncertain", { reason: r.reason });
        return { state: "invalid", code: "session_refresh_uncertain" };
      }
      if (r.status === 200 && r.json?.accessToken && r.json?.refreshToken) {
        const ok = store.updateTokens(sessionId, generation, {
          accessToken: r.json.accessToken,
          refreshToken: r.json.refreshToken,
          accessExpiresAt: now() + Number(r.json.expiresIn || 0) * 1000,
        });
        if (!ok) { log("refresh_discarded"); return { state: "invalid", code: "session_expired" }; }
        log("refresh_ok");
        return { state: "ok" };
      }
      if (r.status === 401) { store.delete(sessionId); log("refresh_rejected"); return { state: "invalid", code: "session_expired" }; }
      // 5xx/429: o backend respondeu sem confirmar a rotação (transação revertida) → mantém a sessão.
      return { state: "unavailable" };
    })();
    s.refreshing = promise;
    try {
      const outcome = await promise;
      if (outcome.state !== "ok") return outcome;
      const fresh = store.get(sessionId);
      return fresh ? { state: "ok", session: fresh } : { state: "invalid", code: "session_expired" };
    } finally {
      if (s.refreshing === promise) s.refreshing = null;
    }
  }

  function freshFailure(outcome) {
    if (outcome.state === "unavailable") return err(503, "backend_unavailable", "Serviço indisponível. Tente novamente.");
    return ended(outcome.code, outcome.code === "session_refresh_uncertain"
      ? "Não foi possível confirmar a renovação da sessão. Entre novamente."
      : "Sessão encerrada. Entre novamente.");
  }

  // ------------------------------------------------------------------ rotas
  async function register(request) {
    const denied = guard(request);
    if (denied) return err(denied.status, denied.code, denied.message);
    const body = await readJson(request);
    if (body.error) return body.error;
    const r = await callBackend(ctx, { method: "POST", path: "/auth/register", body: body.value ?? {}, clientIp: clientIp(request) });
    if (r.kind === "unreachable") return err(503, "backend_unavailable", "Serviço indisponível. Tente novamente.");
    if (r.kind === "uncertain") return err(504, "upstream_timeout", "Sem confirmação do servidor; verifique antes de repetir.");
    return passthrough(r);
  }

  async function login(request) {
    const denied = guard(request);
    if (denied) return err(denied.status, denied.code, denied.message);
    const body = await readJson(request);
    if (body.error) return body.error;
    // Troca de usuário/novo login: a sessão anterior deste navegador é encerrada antes.
    const previous = readSessionId(request.headers.get("cookie"), config);
    if (previous) await endSession(previous);
    const r = await callBackend(ctx, { method: "POST", path: "/auth/login", body: body.value ?? {}, clientIp: clientIp(request) });
    if (r.kind === "unreachable") return err(503, "backend_unavailable", "Serviço indisponível. Tente novamente.");
    if (r.kind === "uncertain") return err(504, "upstream_timeout", "Sem confirmação do servidor. Tente entrar novamente.");
    if (r.status !== 200) return passthrough(r);
    const { accessToken, refreshToken, expiresIn, user } = r.json ?? {};
    if (!accessToken || !refreshToken || !user?.id) return err(502, "upstream_error", "Resposta inválida do servidor.");
    let id;
    try {
      id = store.create({ userId: user.id, accessToken, refreshToken, accessExpiresAt: now() + Number(expiresIn) * 1000 });
    } catch (e) {
      if (e instanceof SessionCapacityError) {
        await callBackend(ctx, { method: "POST", path: "/auth/logout", token: accessToken });
        return err(503, "session_capacity_reached", "Muitas sessões ativas no momento. Tente novamente mais tarde.");
      }
      throw e;
    }
    log("login_ok");
    return json(200, { user }, { "set-cookie": sessionCookie(config, id, config.session.maxAgeSeconds) });
  }

  async function endSession(sessionId) {
    const snapshot = store.delete(sessionId);          // 1º: invalida localmente (sem novas operações)
    if (snapshot?.accessToken) {                       // 2º: tenta revogar no backend
      const r = await callBackend(ctx, { method: "POST", path: "/auth/logout", token: snapshot.accessToken });
      log("logout_backend", { result: r.kind === "response" ? r.status : r.kind });
    }
  }

  async function logout(request) {
    const denied = guard(request);
    if (denied) return err(denied.status, denied.code, denied.message);
    const id = readSessionId(request.headers.get("cookie"), config);
    if (id) await endSession(id);
    return json(204, null, { "set-cookie": clearSessionCookie(config) });
  }

  async function session(request) {
    const denied = guard(request);
    if (denied) return err(denied.status, denied.code, denied.message);
    const id = readSessionId(request.headers.get("cookie"), config);
    if (!id || !store.get(id)) return json(200, { authenticated: false });
    const outcome = await ensureFresh(id);
    if (outcome.state !== "ok") return freshFailure(outcome);
    const r = await callBackend(ctx, { method: "GET", path: "/auth/me", token: outcome.session.accessToken });
    if (r.kind !== "response") return err(503, "backend_unavailable", "Serviço indisponível. Tente novamente.");
    if (r.status === 401) { store.delete(id); return ended("session_expired", "Sessão encerrada. Entre novamente."); }
    if (r.status !== 200) return passthrough(r);
    return json(200, { authenticated: true, user: r.json.user });
  }

  async function proxy(request, path) {
    const method = request.method;
    const match = matchAllowlist(method, path);
    if (match === "not_found") return err(404, "not_found", "Recurso não encontrado.");
    if (match === "method_not_allowed") return err(405, "method_not_allowed", "Método não permitido.");
    const denied = guard(request);
    if (denied) return err(denied.status, denied.code, denied.message);
    const id = readSessionId(request.headers.get("cookie"), config);
    if (!id) return err(401, "not_authenticated", "Não autenticado.");
    let body;
    if (method !== "GET") {
      const parsed = await readJson(request);
      if (parsed.error) return parsed.error;
      body = parsed.value ?? {};
    }
    const outcome = await ensureFresh(id);               // renova ANTES do envio
    if (outcome.state !== "ok") return freshFailure(outcome);
    const r = await callBackend(ctx, { method, path, token: outcome.session.accessToken, body, clientIp: clientIp(request) });
    if (r.kind === "unreachable") return err(503, "backend_unavailable", "Serviço indisponível. Tente novamente.");
    if (r.kind === "uncertain") {
      // Mutação com resultado desconhecido: NUNCA repetir automaticamente.
      return method === "GET"
        ? err(503, "backend_unavailable", "Serviço indisponível. Tente novamente.")
        : json(504, { error: { code: "upstream_timeout", message: "Sem confirmação do servidor; verifique antes de repetir." }, outcome: "unknown" });
    }
    if (r.status === 401) {
      // Sessão revogada no backend (logout em outro lugar, redefinição de senha...). Sem nova tentativa.
      store.delete(id);
      return ended("session_expired", "Sessão encerrada. Entre novamente.");
    }
    return passthrough(r);
  }

  return { register, login, logout, session, proxy, ensureFresh, CSRF_HEADER };
}
