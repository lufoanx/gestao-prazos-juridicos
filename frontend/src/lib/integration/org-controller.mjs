// Vínculo e ambiente no MODO INTEGRADO (6.2). Sem React, testável.
//
// - Fonte da verdade: GET /memberships/me (servidor). Nada de officeId ou permissões guardados
//   localmente: o ambiente escolhido é só contexto de navegação, nunca autorização.
// - Ambiente pessoal sempre existe; o de escritório só se houver vínculo atual.
// - Mudança de usuário, escritório ou perda de vínculo → `onReset` (limpa caches/dados) e nova
//   época do cliente (respostas antigas descartadas).
// - Avisos entre abas apenas pedem ressincronização.
import { ApiError, StaleResponseError } from "./api-client.mjs";

export const ADMIN_PERMS = Object.freeze(["team.manage", "office.manage"]);
export const MEMBER_PERMS = Object.freeze(["deadline.read", "deadline.create", "deadline.edit", "deadline.complete"]);
export const ALL_PERMS = Object.freeze([...MEMBER_PERMS, "deadline.transfer", ...ADMIN_PERMS]);

/** Capacidades para EXIBIR controles (o servidor decide de verdade). Cargo não conta. */
export function capabilities(membership) {
  const perms = new Set(membership?.permissions ?? []);
  const isAdmin = perms.has("team.manage") && perms.has("office.manage");
  return {
    isAdmin,
    canManageTeam: perms.has("team.manage"),
    canManageOffice: perms.has("office.manage"),
    canGrantEntry: perms.has("team.manage") && MEMBER_PERMS.every((p) => perms.has(p)),
    visibilityAll: membership?.visibility === "all",
  };
}

/** Permissões que o ator pode marcar ao editar alguém (delegação limitada às próprias). */
export function grantablePermissions(actor) {
  const own = new Set(actor?.permissions ?? []);
  const admin = capabilities(actor).isAdmin;
  return ALL_PERMS.filter((p) => own.has(p) && (admin || !ADMIN_PERMS.includes(p)));
}

/** O ator pode tentar editar o alvo? (gestor não altera gestores/administradores; ninguém edita a si). */
export function canEditTarget(actor, actorId, target) {
  const caps = capabilities(actor);
  if (!caps.canManageTeam || !target || target.userId === actorId) return false;
  const targetPerms = new Set(target.permissions ?? []);
  const targetIsManager = targetPerms.has("team.manage") || targetPerms.has("office.manage");
  return caps.isAdmin || !targetIsManager;
}

/**
 * `scopeStore` (opcional): guarda SÓ a preferência de navegação ("personal" | "office") por usuário,
 * para sobreviver a recarregamentos. Não é autoridade: o escritório só é selecionado se o servidor
 * confirmar o vínculo atual.
 */
export function createOrgController({ org, api, channel = null, onReset = () => {}, scopeStore = null }) {
  let state = { status: "idle", userId: null, office: null, membership: null, scope: "personal", error: null };
  const listeners = new Set();
  let seq = 0;

  const set = (next) => { state = { ...state, ...next }; for (const l of listeners) l(state); };
  const announce = () => { try { channel?.postMessage({ type: "org-changed" }); } catch { /* aba fechada */ } };

  /** Recarrega o vínculo do servidor. `preferOffice` decide o ambiente ao ganhar vínculo. */
  async function refresh({ userId = state.userId, preferOffice = false } = {}) {
    const mine = ++seq;
    if (!userId) { reset(null); return state; }
    if (state.status === "idle" || state.userId !== userId) set({ status: "loading", userId });
    try {
      const data = await org.membership();
      if (mine !== seq) return state;                                  // resposta antiga
      const newOfficeId = data?.office?.id ?? null;
      const oldOfficeId = state.office?.id ?? null;
      const permsChanged = JSON.stringify(state.membership?.permissions ?? []) !== JSON.stringify(data?.membership?.permissions ?? [])
        || state.membership?.visibility !== data?.membership?.visibility;
      if (state.userId !== userId || newOfficeId !== oldOfficeId || permsChanged) {
        api.bumpEpoch();
        onReset({ reason: newOfficeId ? "org-changed" : "no-office" });
      }
      const firstLoad = state.userId !== userId || state.status !== "ready";
      const stored = scopeStore?.get(userId) ?? null;
      let scope;
      if (!newOfficeId) scope = "personal";
      else if (preferOffice) scope = "office";
      else if (firstLoad) scope = stored === "personal" ? "personal" : "office";
      else if (oldOfficeId !== newOfficeId) scope = "office";
      else scope = state.scope;
      if (scope === "office" || newOfficeId) scopeStore?.set(userId, scope);
      set({ status: "ready", userId, office: data?.office ?? null, membership: data?.membership ?? null, scope, error: null });
      return state;
    } catch (e) {
      if (e instanceof StaleResponseError || mine !== seq) return state;
      const code = e instanceof ApiError ? e.category : "error";
      set({ status: code === "unavailable" || code === "network" ? "unavailable" : "error", error: e instanceof ApiError ? e.code : "error" });
      throw e;
    }
  }

  function reset(userId) {
    seq++;
    onReset({ reason: "reset" });
    set({ status: userId ? "loading" : "idle", userId, office: null, membership: null, scope: "personal", error: null });
  }

  /** Ambiente de navegação. Escritório só se o vínculo atual existir (o servidor decide o resto). */
  function selectScope(scope) {
    if (scope === "office" && !state.office) return false;
    if (scope !== "office" && scope !== "personal") return false;
    if (scope !== state.scope) { api.bumpEpoch(); set({ scope }); }
    if (state.userId) scopeStore?.set(state.userId, scope);
    return true;
  }

  /** Após 403/404 de escritório: revalida o vínculo (sem logout). */
  async function revalidate() {
    try { await refresh(); } catch { /* estado já reflete o erro */ }
  }

  /** Após mutação relevante: ressincroniza e avisa as outras abas. */
  async function changed(opts) {
    const r = await refresh(opts);
    announce();
    return r;
  }

  if (channel) channel.onmessage = (ev) => { if (ev.data?.type === "org-changed") void revalidate(); };

  return {
    get state() { return state; },
    subscribe(l) { listeners.add(l); return () => listeners.delete(l); },
    refresh, reset, selectScope, revalidate, changed,
  };
}
