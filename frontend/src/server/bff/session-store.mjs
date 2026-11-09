// Armazenamento de sessões do BFF EM MEMÓRIA (um processo Node).
//
// - O navegador recebe só o identificador aleatório (cookie HttpOnly); access e refresh
//   tokens ficam APENAS aqui.
// - Expiração por inatividade e por idade máxima; limpeza periódica; capacidade configurável
//   (ao atingir o teto, novas sessões são recusadas — nunca se derruba a sessão de outra pessoa).
// - Ao terminar, os tokens são apagados do objeto antes da remoção.
// - Um único Map (id → sessão); a renovação em andamento fica NA PRÓPRIA sessão (sem mapas
//   auxiliares).
// - Coordenação login × logout (auditoria 6.1, v3): cada sessão guarda o NOME do seu cookie e
//   UM bilhete de login pendente. Não há registro de logouts: um cookie sem sessão viva nunca é
//   reabilitado (login com ele é recusado), então nada depende de TTL nem de capacidade.
// Limitações: perde tudo ao reiniciar; não funciona com várias instâncias nem serverless.
import { randomBytes } from "node:crypto";

export class SessionCapacityError extends Error {}

export function newSessionId() {
  return randomBytes(32).toString("base64url"); // 43 caracteres
}

/**
 * @param {{ maxSessions: number, idleSeconds: number, maxAgeSeconds: number, sweepIntervalSeconds: number }} limits
 * @param {() => number} now  relógio em ms (injetável)
 */
export function createMemorySessionStore(limits, now = () => Date.now()) {
  /** @type {Map<string, any>} */
  const sessions = new Map();
  let lastSweep = 0;

  const expired = (s, t) =>
    t - s.lastSeenAt >= limits.idleSeconds * 1000 || t - s.createdAt >= limits.maxAgeSeconds * 1000;

  function wipe(s) {
    s.accessToken = "";
    s.refreshToken = "";
    s.ended = true;
  }

  function remove(id) {
    const s = sessions.get(id);
    if (!s) return null;
    sessions.delete(id);
    const snapshot = { accessToken: s.accessToken };
    wipe(s);
    return snapshot;
  }

  function sweep(force = false) {
    const t = now();
    if (!force && t - lastSweep < limits.sweepIntervalSeconds * 1000) return 0;
    lastSweep = t;
    let n = 0;
    for (const [id, s] of sessions) {
      if (expired(s, t)) { remove(id); n++; }
    }
    return n;
  }

  return {
    get size() { return sessions.size; },

    create({ userId, accessToken, refreshToken, accessExpiresAt, cookieName, browserId = null }) {
      sweep();
      if (sessions.size >= limits.maxSessions) {
        sweep(true);
        if (sessions.size >= limits.maxSessions) throw new SessionCapacityError("capacidade de sessões atingida");
      }
      const id = newSessionId();
      const t = now();
      sessions.set(id, {
        id, userId, accessToken, refreshToken, accessExpiresAt, cookieName, browserId,
        createdAt: t, lastSeenAt: t, generation: 1, refreshing: null, ended: false, pendingLogin: null,
      });
      return id;
    },

    /** Sessão ativa (ou null). Expiradas são removidas no acesso. Atualiza a inatividade. */
    get(id) {
      sweep();
      const s = id ? sessions.get(id) : undefined;
      if (!s) return null;
      if (expired(s, now())) { remove(id); return null; }
      s.lastSeenAt = now();
      return s;
    },

    /** Troca os tokens SÓ se a sessão ainda existe e está na mesma geração (sem recriar). */
    updateTokens(id, generation, { accessToken, refreshToken, accessExpiresAt }) {
      const s = sessions.get(id);
      if (!s || s.ended || s.generation !== generation) return false;
      s.accessToken = accessToken;
      s.refreshToken = refreshToken;
      s.accessExpiresAt = accessExpiresAt;
      s.generation += 1;
      return true;
    },

    /** Remove a sessão e apaga os tokens; devolve o access token para revogação no backend. */
    delete(id) { return remove(id); },

    sweep,

    /** Associa um login pendente à sessão do cookie atual; cancela o pendente anterior (se houver). */
    attachPendingLogin(id, ticket) {
      const s = id ? sessions.get(id) : undefined;
      if (!s || s.ended) return false;
      if (s.pendingLogin && s.pendingLogin !== ticket) s.pendingLogin.cancelled = true;
      s.pendingLogin = ticket;
      return true;
    },

    detachPendingLogin(id, ticket) {
      const s = id ? sessions.get(id) : undefined;
      if (s && s.pendingLogin === ticket) s.pendingLogin = null;
    },

    /** Logout: cancela o login pendente associado a esta sessão (se houver). */
    cancelPendingLogin(id) {
      const s = sessions.get(id);
      if (s?.pendingLogin) s.pendingLogin.cancelled = true;
    },

    /** Ids das sessões vivas deste navegador (varredura das próprias sessões; sem índice extra). */
    liveOfBrowser(browserId) {
      if (!browserId) return [];
      const t = now();
      const out = [];
      for (const [id, s] of sessions) {
        if (s.browserId === browserId && !s.ended && !expired(s, t)) out.push({ value: id, name: s.cookieName });
      }
      return out;
    },

    /** A sessão `id` está viva E pertence ao cookie `name`? (sem tocar na inatividade) */
    isLive(id, name) {
      const s = id ? sessions.get(id) : undefined;
      return Boolean(s && !s.ended && s.cookieName === name && !expired(s, now()));
    },

    remainingSeconds(s) {
      const t = now();
      return Math.max(0, Math.min(
        limits.idleSeconds * 1000 - (t - s.lastSeenAt),
        limits.maxAgeSeconds * 1000 - (t - s.createdAt),
      ) / 1000);
    },
  };
}
