// Armazenamento de sessões do BFF EM MEMÓRIA (um processo Node) — demonstração local, development e testes.
// Para ambientes hospedados use o armazenamento compartilhado (session-store-pg.mjs); a configuração
// recusa `memory` em PRAZOAI_APP_ENV=staging|production.
//
// CONTRATO COMUM DOS ARMAZENAMENTOS (memória e PostgreSQL) — todos os métodos são assíncronos e cada
// um é ATÔMICO em relação aos demais (aqui: corpo síncrono num único processo; no PostgreSQL:
// transação/instrução única com bloqueio). O gerenciador (manager.mjs) nunca compõe decisões de
// segurança a partir de leituras separadas: as seções críticas são operações do armazenamento.
//
// - O navegador recebe só o identificador aleatório (cookie HttpOnly); access e refresh
//   tokens ficam APENAS no servidor.
// - Expiração por inatividade e por idade máxima; limpeza periódica; capacidade configurável
//   (ao atingir o teto, novas sessões são recusadas — nunca se derruba a sessão de outra pessoa).
// - Ao terminar, os tokens são apagados do objeto antes da remoção.
// - Coordenação login × logout (auditoria 6.1, v3): cada sessão guarda o NOME do seu cookie e UM
//   bilhete de login pendente (identificador). Um bilhete é válido enquanto a sessão estiver viva e
//   o bilhete ainda for o pendente dela: outro login com o mesmo cookie o substitui (cancela) e o
//   logout encerra a sessão (cancela). Não há registro de logouts.
// - Renovação entre instâncias: um "arrendamento" (lease) condicionado à geração da sessão garante
//   um único refresh por geração; aqui é trivial (um processo), mas segue o mesmo contrato.
// Limitações: perde tudo ao reiniciar; não funciona com várias instâncias nem serverless.
import { randomBytes } from "node:crypto";

export class SessionCapacityError extends Error {}
/** Armazenamento compartilhado indisponível (rede, banco). Resposta 503 sem detalhes. */
export class SessionStoreUnavailableError extends Error {}

export function newSessionId() {
  return randomBytes(32).toString("base64url"); // 43 caracteres
}

export function newTicket() {
  return randomBytes(16).toString("base64url");
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

  function live(id, name) {
    const s = id ? sessions.get(id) : undefined;
    return s && !s.ended && (name === undefined || s.cookieName === name) && !expired(s, now()) ? s : null;
  }

  function wipe(s) {
    s.accessToken = "";
    s.refreshToken = "";
    s.ended = true;
    s.pendingLogin = null;
  }

  function remove(id) {
    const s = sessions.get(id);
    if (!s) return null;
    sessions.delete(id);
    const snapshot = { accessToken: s.accessToken };
    wipe(s);
    return snapshot;
  }

  function sweepSync(force = false) {
    const t = now();
    if (!force && t - lastSweep < limits.sweepIntervalSeconds * 1000) return 0;
    lastSweep = t;
    let n = 0;
    for (const [id, s] of sessions) {
      if (expired(s, t)) { remove(id); n++; }
    }
    return n;
  }

  function insert({ userId, accessToken, refreshToken, accessExpiresAt, cookieName, browserId = null }) {
    sweepSync();
    if (sessions.size >= limits.maxSessions) {
      sweepSync(true);
      if (sessions.size >= limits.maxSessions) throw new SessionCapacityError("capacidade de sessões atingida");
    }
    const id = newSessionId();
    const t = now();
    sessions.set(id, {
      id, userId, accessToken, refreshToken, accessExpiresAt, cookieName, browserId,
      createdAt: t, lastSeenAt: t, generation: 1, ended: false, pendingLogin: null,
      refreshOwner: null, refreshLeaseUntil: 0,
    });
    return id;
  }

  function endEntries(entries, browserId) {
    const tokens = [];
    const end = (id) => {
      const snap = remove(id);
      if (snap?.accessToken) tokens.push(snap.accessToken);
    };
    for (const e of entries) if (live(e.value, e.name)) end(e.value);
    if (browserId) {
      for (const [id, s] of sessions) if (s.browserId === browserId && live(id)) end(id);
    }
    return tokens;
  }

  return {
    kind: "memory",
    get size() { return sessions.size; },

    async count() { return sessions.size; },

    async create(fields) { return insert(fields); },

    /** Sessão ativa (ou null). Expiradas são removidas no acesso. Atualiza a inatividade. */
    async get(id) {
      sweepSync();
      const s = id ? sessions.get(id) : undefined;
      if (!s) return null;
      if (expired(s, now())) { remove(id); return null; }
      s.lastSeenAt = now();
      return s;
    },

    /** Geração e renovação em andamento, sem tocar na inatividade (para quem espera outra renovação). */
    async peek(id) {
      const s = live(id);
      return s ? { generation: s.generation, refreshing: s.refreshLeaseUntil > now() } : null;
    },

    /** Data de criação da sessão `id` se ela está viva E pertence ao cookie `name` (sem tocar na inatividade). */
    async liveInfo(id, name) {
      const s = live(id, name);
      return s ? { createdAt: s.createdAt } : null;
    },

    async isLive(id, name) { return Boolean(live(id, name)); },

    /** Troca os tokens SÓ se a sessão ainda existe e está na mesma geração (sem recriar); libera o lease. */
    async updateTokens(id, generation, { accessToken, refreshToken, accessExpiresAt }) {
      const s = sessions.get(id);
      if (!s || s.ended || s.generation !== generation) return false;
      s.accessToken = accessToken;
      s.refreshToken = refreshToken;
      s.accessExpiresAt = accessExpiresAt;
      s.generation += 1;
      s.refreshOwner = null;
      s.refreshLeaseUntil = 0;
      return true;
    },

    /** Remove a sessão e apaga os tokens; devolve o access token para revogação no backend. */
    async delete(id) { return remove(id); },

    /**
     * Encerra, numa operação atômica, as sessões vivas listadas (nome do cookie conferido) e todas as
     * sessões vivas do navegador `browserId` (se informado). Devolve os access tokens a revogar.
     */
    async endSessions(entries, browserId = null) { return endEntries(entries, browserId); },

    async sweep(force = false) { return sweepSync(force); },

    /** Associa um login pendente à sessão do cookie atual; substitui (cancela) o pendente anterior. */
    async attachPendingLogin(id, ticket) {
      const s = live(id);
      if (!s) return false;
      s.pendingLogin = ticket;
      return true;
    },

    async detachPendingLogin(id, ticket) {
      const s = id ? sessions.get(id) : undefined;
      if (s && s.pendingLogin === ticket) s.pendingLogin = null;
    },

    /**
     * Finalização ATÔMICA do login: valida (bilhete ainda pendente na sessão atual viva, se houver) e
     * publica (cria a sessão nova e encerra a atual e as antigas) sem intercalação.
     * @returns {Promise<{ status: "ok", id: string, previousTokens: string[] } | { status: "cancelled" } | { status: "capacity" }>}
     */
    async publishLogin({ current, ticket, olderLive = [], session }) {
      if (current) {
        const s = live(current.value, current.name);
        if (!s || s.pendingLogin !== ticket) return { status: "cancelled" };
      }
      let id;
      try {
        id = insert(session);
      } catch (e) {
        if (e instanceof SessionCapacityError) return { status: "capacity" };
        throw e;
      }
      const previousTokens = endEntries([...(current ? [current] : []), ...olderLive], null);
      return { status: "ok", id, previousTokens };
    },

    /** Lease de renovação: concedido só se a sessão está viva, na geração esperada e sem lease ativo. */
    async acquireRefresh(id, generation, owner, leaseMs) {
      const s = live(id);
      if (!s || s.generation !== generation || s.refreshLeaseUntil > now()) return false;
      s.refreshOwner = owner;
      s.refreshLeaseUntil = now() + leaseMs;
      return true;
    },

    async releaseRefresh(id, owner) {
      const s = sessions.get(id);
      if (s && s.refreshOwner === owner) { s.refreshOwner = null; s.refreshLeaseUntil = 0; }
    },

    async ping() { return true; },
    async close() {},
  };
}
