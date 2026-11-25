// Armazenamento COMPARTILHADO das sessões do BFF no PostgreSQL (ambientes hospedados e testes).
//
// Mesmo contrato de session-store.mjs (memória). Diferenças necessárias para várias instâncias:
// - toda decisão de segurança é UMA instrução SQL condicional ou UMA transação com bloqueio
//   (nunca "ler, decidir no Node, escrever");
// - publicar login, encerrar sessões (logout, ressincronização) e criar sessões passam pelo MESMO
//   bloqueio consultivo transacional, para que um logout e um login concorrentes em instâncias
//   diferentes tenham uma ordem total (o logout concluído nunca é revertido por um login anterior);
// - a renovação usa um lease condicionado à geração: só uma instância chama /auth/refresh por
//   geração; as demais aguardam a troca de geração (manager.mjs). O VENCIMENTO do lease não o libera
//   (não prova que o backend deixou de processar): tentativa vencida = resultado desconhecido → a sessão
//   é encerrada (`abandonRefresh`) e a publicação tardia do antigo dono é recusada (`updateTokens`
//   exige ser o dono com lease válido);
// - em repouso: só o SHA-256 do id de sessão e do id do navegador; tokens cifrados (AES-256-GCM,
//   session-crypto.mjs). Erros do driver nunca chegam a respostas ou logs com dados.
// O relógio (ms) é o do processo Node, injetável: as instâncias precisam de NTP (desvio de poucos
// segundos só antecipa/adia a expiração por inatividade nessa medida).
import pg from "pg";
import { BFF_SCHEMA, SessionSchemaError, ensureSchemaReady } from "./session-schema.mjs";
import { SessionDecryptError, hashId } from "./session-crypto.mjs";
import { SessionCapacityError, SessionStoreUnavailableError, newSessionId } from "./session-store.mjs";

const STRUCTURE_LOCK = 7340170001;           // bloqueio consultivo das mutações estruturais
const T = `${BFF_SCHEMA}.sessions`;

/** Pool dedicado (papel próprio do BFF; nunca o papel do backend). */
export function createSessionPool({ databaseUrl, poolMax, statementTimeoutMs = 5000, lockTimeoutMs = 3000 }) {
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: poolMax,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30_000,
    application_name: "prazoai-bff",
    options: `-c statement_timeout=${statementTimeoutMs} -c lock_timeout=${lockTimeoutMs}`,
  });
  // Erros de conexões ociosas não podem derrubar o processo; nada de dados no log.
  pool.on("error", (e) => console.error("bff_session_pool_error", e?.code || "erro"));
  return pool;
}

/**
 * @param {{ pool: import("pg").Pool, limits: { maxSessions: number, idleSeconds: number, maxAgeSeconds: number, sweepIntervalSeconds: number },
 *   cipher: ReturnType<typeof import("./session-crypto.mjs").createSessionCipher>, now?: () => number,
 *   logger?: { info?: Function, error?: Function } }} deps
 */
export function createPgSessionStore({ pool, limits, cipher, now = () => Date.now(), logger = console }) {
  let readyPromise = null;
  let lastSweep = 0;

  const cuts = (t) => [t - limits.idleSeconds * 1000, t - limits.maxAgeSeconds * 1000];
  const LIVE = (i) => `last_seen_at > $${i} AND created_at > $${i + 1}`;

  function ready() {
    if (!readyPromise) {
      readyPromise = ensureSchemaReady(pool).catch((e) => { readyPromise = null; throw e; });
    }
    return readyPromise;
  }

  function guarded(fn) {
    return async (...args) => {
      try {
        await ready();
        return await fn(...args);
      } catch (e) {
        if (e instanceof SessionCapacityError || e instanceof SessionSchemaError) throw e;
        logger.error?.("bff_session_store_error", { code: typeof e?.code === "string" ? e.code : "erro" });
        throw new SessionStoreUnavailableError("armazenamento de sessões indisponível");
      }
    };
  }

  async function tx(fn) {
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      const out = await fn(c);
      await c.query("COMMIT");
      return out;
    } catch (e) {
      await c.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      c.release();
    }
  }

  const lock = (c) => c.query("SELECT pg_advisory_xact_lock($1)", [STRUCTURE_LOCK]);

  function decryptToken(field, h, blob) {
    try { return cipher.decrypt(field, h, blob); } catch (e) {
      if (e instanceof SessionDecryptError) return null;
      throw e;
    }
  }

  async function deleteExpired(c, t) {
    const [idleCut, ageCut] = cuts(t);
    const r = await c.query(`DELETE FROM ${T} WHERE NOT (${LIVE(1)})`, [idleCut, ageCut]);
    return r.rowCount ?? 0;
  }

  async function maybeSweep(force = false) {
    const t = now();
    if (!force && t - lastSweep < limits.sweepIntervalSeconds * 1000) return 0;
    lastSweep = t;
    return deleteExpired(pool, t);
  }

  async function countLive(c, t) {
    const [idleCut, ageCut] = cuts(t);
    const r = await c.query(`SELECT count(*)::int AS n FROM ${T} WHERE ${LIVE(1)}`, [idleCut, ageCut]);
    return r.rows[0].n;
  }

  /** Insere sob o bloqueio estrutural (chamador já o detém). Lança SessionCapacityError. */
  async function insert(c, { userId, accessToken, refreshToken, accessExpiresAt, cookieName, browserId = null }) {
    const t = now();
    if (await countLive(c, t) >= limits.maxSessions) {
      await deleteExpired(c, t);
      if (await countLive(c, t) >= limits.maxSessions) throw new SessionCapacityError("capacidade de sessões atingida");
    }
    const id = newSessionId();
    const h = hashId(id);
    await c.query(
      `INSERT INTO ${T} (id_hash, cookie_name, browser_hash, user_id, access_token_enc, refresh_token_enc,
         access_expires_at, generation, created_at, last_seen_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 1, $8, $8)`,
      [h, cookieName, browserId ? hashId(browserId) : null, String(userId),
        cipher.encrypt("access", h, accessToken), cipher.encrypt("refresh", h, refreshToken),
        Math.floor(accessExpiresAt), t],
    );
    return id;
  }

  /** Remove sob o bloqueio estrutural as sessões vivas listadas e as do navegador; devolve access tokens. */
  async function endEntries(c, entries, browserId) {
    const t = now();
    const [idleCut, ageCut] = cuts(t);
    const hashes = entries.map((e) => hashId(e.value));
    const names = entries.map((e) => String(e.name));
    const r = await c.query(
      `DELETE FROM ${T}
        WHERE ${LIVE(1)}
          AND ((id_hash, cookie_name) IN (SELECT * FROM unnest($3::bytea[], $4::text[]))
               OR ($5::bytea IS NOT NULL AND browser_hash = $5))
        RETURNING id_hash, access_token_enc`,
      [idleCut, ageCut, hashes, names, browserId ? hashId(browserId) : null],
    );
    return r.rows.map((row) => decryptToken("access", row.id_hash, row.access_token_enc)).filter(Boolean);
  }

  return {
    kind: "postgres",

    count: guarded(async () => countLive(pool, now())),

    create: guarded(async (fields) => tx(async (c) => { await lock(c); return insert(c, fields); })),

    get: guarded(async (id) => {
      if (!id) return null;
      await maybeSweep();
      const t = now();
      const [idleCut, ageCut] = cuts(t);
      const h = hashId(id);
      const r = await pool.query(
        `UPDATE ${T} SET last_seen_at = GREATEST(last_seen_at, $2)
          WHERE id_hash = $1 AND ${LIVE(3)}
          RETURNING user_id, cookie_name, access_token_enc, refresh_token_enc, access_expires_at, generation,
                    created_at, last_seen_at`,
        [h, t, idleCut, ageCut],
      );
      const row = r.rows[0];
      if (!row) {
        await pool.query(`DELETE FROM ${T} WHERE id_hash = $1 AND NOT (${LIVE(2)})`, [h, idleCut, ageCut]);
        return null;
      }
      const accessToken = decryptToken("access", h, row.access_token_enc);
      const refreshToken = decryptToken("refresh", h, row.refresh_token_enc);
      if (accessToken === null || refreshToken === null) {
        // Chave trocada sem a anterior, ou linha adulterada: a sessão deixa de valer (novo login).
        await pool.query(`DELETE FROM ${T} WHERE id_hash = $1`, [h]);
        logger.error?.("bff_session_undecryptable", {});
        return null;
      }
      return {
        id, userId: row.user_id, cookieName: row.cookie_name, accessToken, refreshToken,
        accessExpiresAt: Number(row.access_expires_at), generation: row.generation,
        createdAt: Number(row.created_at), lastSeenAt: Number(row.last_seen_at),
      };
    }),

    peek: guarded(async (id) => {
      const t = now();
      const [idleCut, ageCut] = cuts(t);
      const r = await pool.query(
        `SELECT generation, refresh_owner, refresh_lease_until FROM ${T} WHERE id_hash = $1 AND ${LIVE(2)}`,
        [hashId(id), idleCut, ageCut],
      );
      const row = r.rows[0];
      if (!row) return null;
      const open = row.refresh_owner !== null;
      const until = Number(row.refresh_lease_until);
      return { generation: row.generation, refreshing: open && until > t, abandoned: open && until <= t };
    }),

    liveInfo: guarded(async (id, name) => {
      const [idleCut, ageCut] = cuts(now());
      const r = await pool.query(
        `SELECT created_at FROM ${T} WHERE id_hash = $1 AND cookie_name = $2 AND ${LIVE(3)}`,
        [hashId(id), String(name), idleCut, ageCut],
      );
      return r.rows[0] ? { createdAt: Number(r.rows[0].created_at) } : null;
    }),

    isLive: guarded(async (id, name) => {
      if (!id) return false;
      const [idleCut, ageCut] = cuts(now());
      const r = await pool.query(
        `SELECT 1 FROM ${T} WHERE id_hash = $1 AND cookie_name = $2 AND ${LIVE(3)}`,
        [hashId(id), String(name), idleCut, ageCut],
      );
      return r.rowCount === 1;
    }),

    // Autoridade para publicar: com `owner`, ser o dono do lease AINDA VÁLIDO; sem `owner`, não haver
    // tentativa em aberto. Uma instância que perdeu o lease não atualiza nem recria a sessão.
    updateTokens: guarded(async (id, generation, { accessToken, refreshToken, accessExpiresAt }, owner = null) => {
      const h = hashId(id);
      const r = await pool.query(
        `UPDATE ${T} SET access_token_enc = $3, refresh_token_enc = $4, access_expires_at = $5,
                generation = generation + 1, refresh_owner = NULL, refresh_lease_until = 0
          WHERE id_hash = $1 AND generation = $2
            AND (($6::text IS NULL AND refresh_owner IS NULL)
                 OR (refresh_owner = $6::text AND refresh_lease_until > $7))`,
        [h, generation, cipher.encrypt("access", h, accessToken), cipher.encrypt("refresh", h, refreshToken),
          Math.floor(accessExpiresAt), owner, now()],
      );
      return r.rowCount === 1;
    }),

    delete: guarded(async (id) => {
      const h = hashId(id);
      const r = await pool.query(`DELETE FROM ${T} WHERE id_hash = $1 RETURNING access_token_enc`, [h]);
      if (!r.rows[0]) return null;
      return { accessToken: decryptToken("access", h, r.rows[0].access_token_enc) ?? "" };
    }),

    endSessions: guarded(async (entries, browserId = null) =>
      tx(async (c) => { await lock(c); return endEntries(c, entries, browserId); })),

    sweep: guarded(async (force = false) => maybeSweep(force)),

    attachPendingLogin: guarded(async (id, ticket) => {
      const [idleCut, ageCut] = cuts(now());
      const r = await pool.query(
        `UPDATE ${T} SET pending_ticket = $2 WHERE id_hash = $1 AND ${LIVE(3)}`,
        [hashId(id), ticket, idleCut, ageCut],
      );
      return r.rowCount === 1;
    }),

    detachPendingLogin: guarded(async (id, ticket) => {
      await pool.query(`UPDATE ${T} SET pending_ticket = NULL WHERE id_hash = $1 AND pending_ticket = $2`,
        [hashId(id), ticket]);
    }),

    publishLogin: guarded(async ({ current, ticket, olderLive = [], session }) => tx(async (c) => {
      await lock(c);
      if (current) {
        const [idleCut, ageCut] = cuts(now());
        const r = await c.query(
          `SELECT pending_ticket FROM ${T} WHERE id_hash = $1 AND cookie_name = $2 AND ${LIVE(3)} FOR UPDATE`,
          [hashId(current.value), String(current.name), idleCut, ageCut],
        );
        if (!r.rows[0] || r.rows[0].pending_ticket !== ticket) return { status: "cancelled" };
      }
      let id;
      try {
        id = await insert(c, session);
      } catch (e) {
        if (e instanceof SessionCapacityError) return { status: "capacity" };
        throw e;
      }
      const previousTokens = await endEntries(c, [...(current ? [current] : []), ...olderLive], null);
      return { status: "ok", id, previousTokens };
    })),

    acquireRefresh: guarded(async (id, generation, owner, leaseMs) => {
      const t = now();
      const [idleCut, ageCut] = cuts(t);
      const r = await pool.query(
        `UPDATE ${T} SET refresh_owner = $3, refresh_lease_until = $4
          WHERE id_hash = $1 AND generation = $2 AND refresh_owner IS NULL AND ${LIVE(5)}`,
        [hashId(id), generation, owner, t + leaseMs, idleCut, ageCut],
      );
      return r.rowCount === 1;
    }),

    // Tentativa abandonada (lease vencido sem conclusão): encerra a sessão numa instrução atômica.
    abandonRefresh: guarded(async (id, generation) => {
      const h = hashId(id);
      const r = await pool.query(
        `DELETE FROM ${T}
          WHERE id_hash = $1 AND generation = $2 AND refresh_owner IS NOT NULL AND refresh_lease_until <= $3
          RETURNING access_token_enc`,
        [h, generation, now()],
      );
      if (!r.rows[0]) return null;
      return { accessToken: decryptToken("access", h, r.rows[0].access_token_enc) ?? "" };
    }),

    // Só para falha comprovadamente anterior ao envio (ou resposta que prova que nada mudou).
    releaseRefresh: guarded(async (id, owner) => {
      await pool.query(
        `UPDATE ${T} SET refresh_owner = NULL, refresh_lease_until = 0 WHERE id_hash = $1 AND refresh_owner = $2`,
        [hashId(id), owner],
      );
    }),

    // Disponibilidade: confere a versão do esquema a CADA chamada (somente leitura; nunca cria nem migra).
    // Divergência invalida o cache de `ready()`, para que as operações seguintes também a percebam.
    ping: guarded(async () => {
      try {
        await ensureSchemaReady(pool);
      } catch (e) {
        readyPromise = null;
        throw e;
      }
      return true;
    }),

    async close() { await pool.end(); },
  };
}
