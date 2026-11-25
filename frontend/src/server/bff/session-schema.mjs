// Esquema PRÓPRIO das sessões do BFF no PostgreSQL (`prazoai_bff`), separado do esquema do domínio
// (`prazoai`, migrado pelo Alembic do backend). O BFF nunca lê nem escreve o esquema do domínio.
//
// Migrations são EXPLÍCITAS (`npm run bff:sessions -- migrate`), nunca no startup; a aplicação só
// confere a versão (somente leitura) e recusa operar com esquema ausente ou diferente.
// Todas as instruções são idempotentes e transacionais. Nenhuma remove dados de outras versões.

export const BFF_SCHEMA = "prazoai_bff";
export const BFF_SCHEMA_VERSION = 1;

/** Migrations em ordem. Cada uma leva o esquema da versão `n - 1` para `n`. */
export const MIGRATIONS = Object.freeze([
  {
    version: 1,
    up: `
CREATE SCHEMA IF NOT EXISTS ${BFF_SCHEMA};
CREATE TABLE IF NOT EXISTS ${BFF_SCHEMA}.schema_version (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  version integer NOT NULL
);
CREATE TABLE IF NOT EXISTS ${BFF_SCHEMA}.sessions (
  id_hash bytea PRIMARY KEY CHECK (octet_length(id_hash) = 32),
  cookie_name text NOT NULL CHECK (char_length(cookie_name) BETWEEN 1 AND 64),
  browser_hash bytea NULL CHECK (browser_hash IS NULL OR octet_length(browser_hash) = 32),
  user_id text NOT NULL CHECK (char_length(user_id) BETWEEN 1 AND 128),
  access_token_enc bytea NOT NULL CHECK (octet_length(access_token_enc) <= 16384),
  refresh_token_enc bytea NOT NULL CHECK (octet_length(refresh_token_enc) <= 4096),
  access_expires_at bigint NOT NULL,
  generation integer NOT NULL DEFAULT 1 CHECK (generation >= 1),
  created_at bigint NOT NULL,
  last_seen_at bigint NOT NULL,
  pending_ticket text NULL CHECK (pending_ticket IS NULL OR char_length(pending_ticket) <= 64),
  refresh_owner text NULL CHECK (refresh_owner IS NULL OR char_length(refresh_owner) <= 64),
  refresh_lease_until bigint NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS sessions_browser_idx ON ${BFF_SCHEMA}.sessions (browser_hash) WHERE browser_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS sessions_last_seen_idx ON ${BFF_SCHEMA}.sessions (last_seen_at);
CREATE INDEX IF NOT EXISTS sessions_created_idx ON ${BFF_SCHEMA}.sessions (created_at);
`,
  },
]);

export class SessionSchemaError extends Error {}

/** Versão atual (null se o esquema não existe). Somente leitura. */
export async function currentVersion(client) {
  const exists = await client.query("SELECT to_regclass($1) IS NOT NULL AS ok", [`${BFF_SCHEMA}.schema_version`]);
  if (!exists.rows[0].ok) return null;
  const r = await client.query(`SELECT version FROM ${BFF_SCHEMA}.schema_version`);
  return r.rows[0]?.version ?? null;
}

export async function ensureSchemaReady(client) {
  const v = await currentVersion(client);
  if (v !== BFF_SCHEMA_VERSION) {
    throw new SessionSchemaError(
      `Esquema das sessões do BFF ${v === null ? "ausente" : `na versão ${v}`}; esperada ${BFF_SCHEMA_VERSION}. `
      + "Rode `npm run bff:sessions -- migrate` com o papel dono do esquema.",
    );
  }
}

/** Aplica as migrations pendentes numa transação, com bloqueio consultivo contra execuções paralelas. */
export async function migrate(client) {
  await client.query("BEGIN");
  try {
    await client.query("SELECT pg_advisory_xact_lock(7340170002)");
    const from = (await currentVersion(client)) ?? 0;
    if (from > BFF_SCHEMA_VERSION) throw new SessionSchemaError(`Esquema em versão mais nova (${from}) que este código.`);
    for (const m of MIGRATIONS) {
      if (m.version <= from) continue;
      await client.query(m.up);
      await client.query(
        `INSERT INTO ${BFF_SCHEMA}.schema_version (singleton, version) VALUES (true, $1)
         ON CONFLICT (singleton) DO UPDATE SET version = EXCLUDED.version`, [m.version],
      );
    }
    await client.query("COMMIT");
    return { from, to: BFF_SCHEMA_VERSION };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  }
}
