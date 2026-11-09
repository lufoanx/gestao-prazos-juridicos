// Armazenamento de sessões do BFF EM MEMÓRIA (um processo Node).
//
// - O navegador recebe só o identificador aleatório (cookie HttpOnly); access e refresh
//   tokens ficam APENAS aqui.
// - Expiração por inatividade e por idade máxima; limpeza periódica; capacidade configurável
//   (ao atingir o teto, novas sessões são recusadas — nunca se derruba a sessão de outra pessoa).
// - Ao terminar, os tokens são apagados do objeto antes da remoção.
// - Um único Map (id → sessão); a renovação em andamento fica NA PRÓPRIA sessão (sem mapas
//   auxiliares).
// - Coordenação login × logout entre abas (correção da auditoria 6.1):
//   * a sessão guarda UM bilhete de login pendente (`pendingLogin`); um novo login com o mesmo
//     cookie substitui (e cancela) o anterior; logout cancela o bilhete;
//   * registro LIMITADO de sessões encerradas por logout (só o hash do id), com TTL curto e teto
//     fixo, para recusar logins que chegam ao servidor depois do logout carregando o cookie antigo.
//     Nada cresce indefinidamente: entradas expiram e as mais antigas são descartadas no teto.
// Limitações: perde tudo ao reiniciar; não funciona com várias instâncias nem serverless.
import { createHash, randomBytes } from "node:crypto";

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
  /** @type {Map<string, number>} hash(id) → expira em (ms); ordem de inserção = mais antigo primeiro */
  const loggedOut = new Map();
  const loggedOutTtlMs = (limits.logoutMemorySeconds ?? 120) * 1000;
  const loggedOutMax = limits.maxSessions;
  let lastSweep = 0;
  const digest = (id) => createHash("sha256").update(id).digest("base64url");

  function pruneLoggedOut() {
    const t = now();
    for (const [k, exp] of loggedOut) {
      if (exp > t) break;              // inserção em ordem crescente de expiração
      loggedOut.delete(k);
    }
  }

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
    pruneLoggedOut();
    return n;
  }

  return {
    get size() { return sessions.size; },

    create({ userId, accessToken, refreshToken, accessExpiresAt }) {
      sweep();
      if (sessions.size >= limits.maxSessions) {
        sweep(true);
        if (sessions.size >= limits.maxSessions) throw new SessionCapacityError("capacidade de sessões atingida");
      }
      const id = newSessionId();
      const t = now();
      sessions.set(id, {
        id, userId, accessToken, refreshToken, accessExpiresAt,
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

    /** Logout: cancela o login pendente desta sessão e registra o id (hash) por tempo limitado. */
    markLoggedOut(id) {
      const s = sessions.get(id);
      if (s?.pendingLogin) s.pendingLogin.cancelled = true;
      pruneLoggedOut();
      const key = digest(id);
      loggedOut.delete(key);
      loggedOut.set(key, now() + loggedOutTtlMs);
      while (loggedOut.size > loggedOutMax) loggedOut.delete(loggedOut.keys().next().value);
    },

    wasLoggedOut(id) {
      if (!id) return false;
      pruneLoggedOut();
      return loggedOut.has(digest(id));
    },

    get loggedOutSize() { return loggedOut.size; },

    remainingSeconds(s) {
      const t = now();
      return Math.max(0, Math.min(
        limits.idleSeconds * 1000 - (t - s.lastSeenAt),
        limits.maxAgeSeconds * 1000 - (t - s.createdAt),
      ) / 1000);
    },
  };
}
