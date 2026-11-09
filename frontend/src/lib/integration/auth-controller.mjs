// Controlador de autenticação do navegador (modo integrado). Sem React, testável.
//
// - Operações de sessão (restaurar, login, cadastro+login, logout) são SERIALIZADAS: um logout
//   pedido durante um login espera o login terminar e então encerra — uma resposta atrasada
//   de login nunca "ressuscita" a sessão depois do logout.
// - Cada login/logout/troca de usuário incrementa a época do cliente (descarta respostas
//   antigas e limpa os dados de domínio via `onReset`).
// - BroadcastChannel apenas AVISA outras abas; a autorização continua no servidor.
// - Estados distintos: loading, anonymous, authenticated, expired, unavailable.
import { ApiError, StaleResponseError } from "./api-client.mjs";

export function createAuthController({ api, channel = null, onReset = () => {} }) {
  let state = { status: "loading", user: null, error: null };
  const listeners = new Set();
  let queue = Promise.resolve();

  const set = (next) => {
    state = { ...state, ...next };
    for (const l of listeners) l(state);
  };
  const serialize = (op) => {
    const run = queue.then(op, op);
    queue = run.catch(() => {});
    return run;
  };
  const reset = () => { api.bumpEpoch(); onReset(); };
  const announce = (type, userId) => { try { channel?.postMessage({ type, userId }); } catch { /* aba fechada */ } };

  async function resync() {
    try {
      const data = await api.request("GET", "/bff/session");
      if (data?.authenticated && data.user) set({ status: "authenticated", user: data.user, error: null });
      else set({ status: "anonymous", user: null, error: null });
    } catch (e) {
      if (e instanceof StaleResponseError) return;
      if (e instanceof ApiError && e.status === 401) set({ status: "anonymous", user: null, error: null });
      else set({ status: "unavailable", error: e instanceof ApiError ? e.code : "network_error" });
    }
  }

  function restore() {
    return serialize(async () => {
      try {
        const data = await api.request("GET", "/bff/session");
        if (data?.authenticated && data.user) set({ status: "authenticated", user: data.user, error: null });
        else set({ status: "anonymous", user: null, error: null });
      } catch (e) {
        if (e instanceof StaleResponseError) return;
        if (e instanceof ApiError && e.status === 401) { reset(); set({ status: "expired", user: null, error: e.code }); }
        else set({ status: "unavailable", error: e instanceof ApiError ? e.code : "network_error" }); // sem logout indevido
      }
    });
  }

  function login(email, password) {
    return serialize(async () => {
      reset();
      try {
        const data = await api.request("POST", "/bff/auth/login", { email, password });
        set({ status: "authenticated", user: data.user, error: null });
        announce("login", data.user.id);
        return data.user;
      } catch (e) {
        // Falha comum preserva a sessão anterior no servidor; login cancelado (logout em outra aba)
        // limpa. Em vez de supor, ressincroniza com o servidor.
        if (!(e instanceof StaleResponseError)) await resync();
        throw e;
      }
    });
  }

  function register(name, email, password) {
    return serialize(() => api.request("POST", "/bff/auth/register", { name, email, password }));
  }

  function logout() {
    return serialize(async () => {
      reset();                                              // limpa dados antes de qualquer resposta
      set({ status: "anonymous", user: null, error: null });
      try { await api.request("POST", "/bff/auth/logout"); } catch { /* sessão local já encerrada */ }
      announce("logout", null);
    });
  }

  /** Chamado quando qualquer requisição autenticada recebe 401 do BFF. */
  function sessionEnded(code = "session_expired") {
    reset();
    set({ status: "expired", user: null, error: code });
  }

  function onMessage(msg) {
    if (!msg || typeof msg !== "object") return;
    // Outra aba saiu: limpa os dados locais e RESSINCRONIZA com o servidor (a sessão deste
    // navegador pode já ter sido substituída por um login mais novo; o aviso não é autoridade).
    if (msg.type === "logout") { reset(); set({ status: "loading", user: null, error: null }); restore(); }
    if (msg.type === "login" && msg.userId !== state.user?.id) { reset(); restore(); }
  }
  if (channel) channel.onmessage = (ev) => onMessage(ev.data);

  return {
    get state() { return state; },
    subscribe(l) { listeners.add(l); return () => listeners.delete(l); },
    restore, login, register, logout, sessionEnded, onMessage,
    updateUser(user) { if (state.status === "authenticated") set({ user }); },
  };
}
