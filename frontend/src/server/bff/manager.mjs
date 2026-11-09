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
import {
  CSRF_HEADER, NO_STORE, browserCookie, checkCsrf, clearCookie, newBrowserId, newCookieName, readBrowserId,
  readSessionCookies, sessionCookie,
} from "./security.mjs";
import { SessionCapacityError } from "./session-store.mjs";

const PASS_HEADERS = ["retry-after", "x-current-version"];

/** Par de tokens válido (refresh ou login)? Campos obrigatórios e `expiresIn` coerente. */
export function validTokenPair(json) {
  if (!json || typeof json !== "object") return false;
  const { accessToken, refreshToken, expiresIn } = json;
  return typeof accessToken === "string" && accessToken.length >= 16 && accessToken.length <= 8192
    && typeof refreshToken === "string" && refreshToken.length >= 16 && refreshToken.length <= 1024
    && Number.isInteger(expiresIn) && expiresIn >= 1 && expiresIn <= 24 * 3600;
}

function json(status, body, extra = {}) {
  const headers = new Headers({ ...NO_STORE, "content-type": "application/json; charset=utf-8" });
  for (const [k, v] of Object.entries(extra)) {
    if (k === "set-cookie") for (const c of [].concat(v)) headers.append("set-cookie", c);
    else headers.set(k, v);
  }
  return new Response(body === null ? null : JSON.stringify(body), { status, headers });
}

const err = (status, code, message, extra) => json(status, { error: { code, message } }, extra);

export function createBff({
  config, store, fetchImpl = fetch, logger = console, now = () => Date.now(), maxResponseBytes,
}) {
  const ctx = { config, fetchImpl, maxResponseBytes };
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

  /** Sessão encerrada: apaga SÓ o cookie dessa sessão (pelo nome exclusivo). */
  function ended(code, message, cookieName) {
    return err(401, code, message, cookieName ? { "set-cookie": clearCookie(config, cookieName) } : {});
  }

  /**
   * Classifica os cookies de sessão da requisição: a sessão viva mais recente é a atual; outras
   * vivas são antigas (serão encerradas); cookies sem sessão viva correspondente são "mortos"
   * e NUNCA voltam a ser aceitos.
   */
  function resolveCookies(request) {
    const live = [];
    const dead = [];
    for (const c of readSessionCookies(request.headers.get("cookie"), config)) {
      if (c.wellFormed && store.isLive(c.value, c.name)) live.push({ ...c, createdAt: store.get(c.value).createdAt });
      else dead.push(c);
    }
    live.sort((a, b) => b.createdAt - a.createdAt || (a.name < b.name ? 1 : -1));
    return { current: live[0] ?? null, olderLive: live.slice(1), dead };
  }

  /** Encerra sessões SINCRONAMENTE (sem espera de rede); devolve os access tokens a revogar. */
  function endNow(entries, { cancelLogins = true } = {}) {
    const tokens = [];
    for (const e of entries) {
      if (cancelLogins) store.cancelPendingLogin(e.value);
      const snap = store.delete(e.value);
      if (snap?.accessToken) tokens.push(snap.accessToken);
    }
    return tokens;
  }

  /** Revogação no backend (depois da decisão já publicada; falhas não reabrem nada). */
  async function revoke(tokens, event) {
    for (const token of tokens) {
      const r = await callBackend(ctx, { method: "POST", path: "/auth/logout", token });
      log(event, { result: r.kind === "response" ? r.status : r.kind });
    }
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
      if (r.status === 200 && !validTokenPair(r.json)) {
        // 200 com par incompleto/inválido: a rotação pode ter ocorrido → incerto (não reenviar).
        store.delete(sessionId);
        log("refresh_uncertain", { reason: "invalid_token_pair" });
        return { state: "invalid", code: "session_refresh_uncertain" };
      }
      if (r.status === 200) {
        const ok = store.updateTokens(sessionId, generation, {
          accessToken: r.json.accessToken,
          refreshToken: r.json.refreshToken,
          accessExpiresAt: now() + r.json.expiresIn * 1000,
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

  function freshFailure(outcome, cookieName) {
    if (outcome.state === "unavailable") return err(503, "backend_unavailable", "Serviço indisponível. Tente novamente.");
    return ended(outcome.code, outcome.code === "session_refresh_uncertain"
      ? "Não foi possível confirmar a renovação da sessão. Entre novamente."
      : "Sessão encerrada. Entre novamente.", cookieName);
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

  /**
   * Login — protocolo (auditoria 6.1, v3):
   * 1. Requisição com cookie(s) de sessão, mas NENHUM vivo → 409 `session_resync_required`,
   *    sem ir ao backend. Cobre o login enviado antes de um logout e entregue depois; nada
   *    depende de registro de logouts, TTL ou capacidade. O navegador ressincroniza (GET
   *    /bff/session apaga os cookies mortos) e o usuário tenta de novo explicitamente.
   * 2. Com sessão viva: um bilhete de login pendente fica nela; logout dessa sessão (qualquer aba)
   *    ou um novo login com o mesmo cookie o cancelam.
   * 3. Sem cookie (primeiro login): não há sessão a encerrar nem a coordenar.
   * 4. FINALIZAÇÃO ATÔMICA: depois da resposta do backend, a validação (bilhete não cancelado e
   *    sessão anterior ainda viva) e a publicação (criar a nova sessão, encerrar a anterior) são
   *    feitas em sequência SÍNCRONA, sem nenhuma espera de rede entre elas. A revogação no backend
   *    (da anterior, ou dos tokens novos se a tentativa perdeu) acontece DEPOIS da decisão e não
   *    reabre nada.
   * 5. Cookies: a nova sessão recebe um cookie de nome exclusivo; a resposta só apaga cookies que
   *    a própria requisição trouxe (pelo nome). Uma tentativa obsoleta nunca toca o cookie de uma
   *    tentativa mais nova.
   * 6. Navegador: a sessão guarda o identificador estável do navegador (cookie `_bid`, criado no
   *    primeiro login). Um logout encerra TODAS as sessões vivas desse navegador — inclusive a
   *    que um login concorrente acabou de publicar. Se isso acontecer antes de a resposta do login
   *    sair, o login responde 409 sem instalar cookie.
   */
  async function login(request) {
    const denied = guard(request);
    if (denied) return err(denied.status, denied.code, denied.message);
    const body = await readJson(request);
    if (body.error) return body.error;
    const { current, olderLive, dead } = resolveCookies(request);
    const knownBrowser = readBrowserId(request.headers.get("cookie"), config);
    const browserId = knownBrowser ?? newBrowserId();
    const clearDead = dead.map((c) => clearCookie(config, c.name));
    if (!current && dead.length > 0) {
      return err(409, "session_resync_required",
        "A sessão anterior deste navegador terminou. Atualize e entre novamente.", { "set-cookie": clearDead });
    }
    const ticket = { cancelled: false };
    const attached = current ? store.attachPendingLogin(current.value, ticket) : false;
    try {
      const r = await callBackend(ctx, { method: "POST", path: "/auth/login", body: body.value ?? {}, clientIp: clientIp(request) });
      if (r.kind === "unreachable") return err(503, "backend_unavailable", "Serviço indisponível. Tente novamente.");
      if (r.kind === "uncertain") return err(504, "upstream_timeout", "Sem confirmação do servidor. Tente entrar novamente.");
      if (r.status !== 200) return passthrough(r);
      const user = r.json?.user;
      if (!validTokenPair(r.json) || !user?.id) return err(502, "upstream_error", "Resposta inválida do servidor.");
      const { accessToken, refreshToken, expiresIn } = r.json;

      // ---- seção crítica SÍNCRONA: validar e publicar sem espera de rede entre os passos ----
      const stillValid = !ticket.cancelled && (!current || store.isLive(current.value, current.name));
      let id = null;
      let cookieName = null;
      let previousTokens = [];
      let capacity = false;
      if (stillValid) {
        cookieName = newCookieName(config);
        try {
          id = store.create({ userId: user.id, accessToken, refreshToken, cookieName, browserId,
            accessExpiresAt: now() + expiresIn * 1000 });
          previousTokens = endNow([...(current ? [current] : []), ...olderLive], { cancelLogins: true });
        } catch (e) {
          if (!(e instanceof SessionCapacityError)) throw e;
          capacity = true;
        }
      }
      // ---- fim da seção crítica ----

      if (!stillValid || capacity) {
        await revoke([accessToken], "login_tokens_revoked");          // a tentativa perdeu: revoga o par novo
        if (capacity) return err(503, "session_capacity_reached", "Muitas sessões ativas no momento. Tente novamente mais tarde.");
        log("login_cancelled");
        // Apaga só cookies que esta requisição trouxe e que agora estão mortos (nunca o de outra tentativa).
        const nowDead = [...dead, ...(current && !store.isLive(current.value, current.name) ? [current] : [])];
        return err(409, "login_cancelled", "A sessão foi encerrada em outra aba durante o login. Entre novamente.",
          { "set-cookie": nowDead.map((c) => clearCookie(config, c.name)) });
      }
      await revoke(previousTokens, "logout_backend");                 // troca de usuário: revoga a anterior
      const consumed = [...clearDead, ...(current ? [clearCookie(config, current.name)] : []),
        ...olderLive.map((c) => clearCookie(config, c.name))];
      if (!store.isLive(id, cookieName)) {
        // Um logout deste navegador encerrou a sessão nova durante a revogação: não instala cookie.
        log("login_cancelled");
        return err(409, "login_cancelled", "A sessão foi encerrada em outra aba durante o login. Entre novamente.",
          { "set-cookie": consumed });
      }
      log("login_ok");
      const cookies = [sessionCookie(config, cookieName, id, config.session.maxAgeSeconds), ...consumed];
      if (!knownBrowser) cookies.push(browserCookie(config, browserId));
      return json(200, { user }, { "set-cookie": cookies });
    } finally {
      if (attached) store.detachPendingLogin(current.value, ticket);
    }
  }

  /**
   * Logout: encerra SINCRONAMENTE todas as sessões vivas que a requisição trouxe (cancelando
   * logins pendentes associados), apaga apenas os cookies observados e depois revoga no backend.
   * Um logout atrasado nunca apaga o cookie de uma sessão mais nova (nome diferente).
   */
  async function logout(request) {
    const denied = guard(request);
    if (denied) return err(denied.status, denied.code, denied.message);
    const { current, olderLive, dead } = resolveCookies(request);
    const live = [...(current ? [current] : []), ...olderLive];
    // Também as sessões vivas deste navegador que a requisição não conhecia (login concorrente
    // já publicado): o logout concluído vence. Não apaga cookies que não observou.
    const seen = new Set(live.map((e) => e.value));
    const sameBrowser = store.liveOfBrowser(readBrowserId(request.headers.get("cookie"), config))
      .filter((e) => !seen.has(e.value));
    const tokens = endNow([...live, ...sameBrowser]);
    const cookies = [...live, ...dead].map((c) => clearCookie(config, c.name));
    await revoke(tokens, "logout_backend");
    return json(204, null, cookies.length ? { "set-cookie": cookies } : {});
  }

  async function session(request) {
    const denied = guard(request);
    if (denied) return err(denied.status, denied.code, denied.message);
    const { current, olderLive, dead } = resolveCookies(request);
    // Ressincronização: apaga cookies mortos e encerra sessões antigas que este navegador ainda carrega.
    const stale = [...dead, ...olderLive];
    const extra = stale.length ? { "set-cookie": stale.map((c) => clearCookie(config, c.name)) } : {};
    const staleTokens = endNow(olderLive);
    if (staleTokens.length) void revoke(staleTokens, "logout_backend");
    if (!current) return json(200, { authenticated: false }, extra);
    const outcome = await ensureFresh(current.value);
    if (outcome.state !== "ok") return freshFailure(outcome, current.name);
    const r = await callBackend(ctx, { method: "GET", path: "/auth/me", token: outcome.session.accessToken });
    if (r.kind !== "response") return err(503, "backend_unavailable", "Serviço indisponível. Tente novamente.");
    if (r.status === 401) { store.delete(current.value); return ended("session_expired", "Sessão encerrada. Entre novamente.", current.name); }
    if (r.status !== 200) return passthrough(r);
    return json(200, { authenticated: true, user: r.json.user }, extra);
  }

  async function proxy(request, path) {
    const method = request.method;
    const match = matchAllowlist(method, path);
    if (match === "not_found") return err(404, "not_found", "Recurso não encontrado.");
    if (match === "method_not_allowed") return err(405, "method_not_allowed", "Método não permitido.");
    const denied = guard(request);
    if (denied) return err(denied.status, denied.code, denied.message);
    const { current } = resolveCookies(request);                 // respostas comuns não mexem em cookies
    if (!current) return err(401, "not_authenticated", "Não autenticado.");
    let body;
    if (method !== "GET") {
      const parsed = await readJson(request);
      if (parsed.error) return parsed.error;
      body = parsed.value ?? {};
    }
    const outcome = await ensureFresh(current.value);           // renova ANTES do envio
    if (outcome.state !== "ok") return freshFailure(outcome, current.name);
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
      store.delete(current.value);
      return ended("session_expired", "Sessão encerrada. Entre novamente.", current.name);
    }
    return passthrough(r);
  }

  return { register, login, logout, session, proxy, ensureFresh, CSRF_HEADER };
}
