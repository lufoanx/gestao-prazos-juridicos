// Sessões COMPARTILHADAS do BFF (PostgreSQL): contrato comum com a memória, proteção em repouso,
// persistência após reinício e coordenação entre INSTÂNCIAS distintas do BFF (pools separados no
// mesmo banco), com o dublê do backend. A integração real com o FastAPI fica em
// tests/integration/bff-shared-sessions-backend.test.mjs.
//
// Requer um PostgreSQL DESCARTÁVEL: PRAZOAI_TEST_BFF_DATABASE_URL=postgresql://.../<banco>_test
// (o nome do banco precisa terminar em "_test" ou começar com "prazoai_test"; o esquema prazoai_bff
// desse banco é recriado). Sem a variável, os casos de PostgreSQL são PULADOS — ou FALHAM com
// PRAZOAI_REQUIRE_BFF_PG_TESTS=1 (CI).
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { loadBffConfig } from "../src/server/bff/config.mjs";
import { createBff } from "../src/server/bff/manager.mjs";
import {
  SessionCapacityError, SessionStoreUnavailableError, createMemorySessionStore, newTicket,
} from "../src/server/bff/session-store.mjs";
import { createPgSessionStore, createSessionPool } from "../src/server/bff/session-store-pg.mjs";
import { createSessionCipher, hashId } from "../src/server/bff/session-crypto.mjs";
import { BFF_SCHEMA_VERSION, SessionSchemaError, currentVersion, migrate } from "../src/server/bff/session-schema.mjs";
import { createFakeBackend, deferred } from "./helpers/fake-backend.mjs";

const DB_URL = process.env.PRAZOAI_TEST_BFF_DATABASE_URL || "";
if (!DB_URL && process.env.PRAZOAI_REQUIRE_BFF_PG_TESTS === "1") {
  throw new Error("PRAZOAI_TEST_BFF_DATABASE_URL obrigatória (PRAZOAI_REQUIRE_BFF_PG_TESTS=1)");
}
if (DB_URL) {
  const name = new URL(DB_URL).pathname.slice(1);
  if (!/(_test$|^prazoai_test)/.test(name)) throw new Error("Banco de teste deve ser descartável (*_test / prazoai_test*)");
}
const PG_SKIP = DB_URL ? false : "PRAZOAI_TEST_BFF_DATABASE_URL não definida";

const KEY_A = Buffer.from(Array.from({ length: 32 }, (_, i) => (i * 13 + 5) % 256));
const KEY_B = Buffer.from(Array.from({ length: 32 }, (_, i) => (i * 29 + 11) % 256));
const LIMITS = { maxSessions: 3, idleSeconds: 60, maxAgeSeconds: 300, sweepIntervalSeconds: 10 };
const pools = [];

function pool() {
  const p = createSessionPool({ databaseUrl: DB_URL, poolMax: 4 });
  pools.push(p);
  return p;
}
async function admin(sql, params) {
  const c = new pg.Client({ connectionString: DB_URL });
  await c.connect();
  try { return await c.query(sql, params); } finally { await c.end(); }
}
async function resetSchema() {
  await admin("DROP SCHEMA IF EXISTS prazoai_bff CASCADE");
  const c = new pg.Client({ connectionString: DB_URL });
  await c.connect();
  try { await migrate(c); } finally { await c.end(); }
}
const quiet = { info() {}, error() {} };
function pgStore(now, { limits = LIMITS, keys = { current: KEY_A } } = {}) {
  return createPgSessionStore({ pool: pool(), limits, cipher: createSessionCipher(keys), now, logger: quiet });
}

before(async () => { if (DB_URL) await resetSchema(); });
after(async () => { await Promise.all(pools.map((p) => p.end().catch(() => {}))); });

// ============================================================== contrato comum (memória e PostgreSQL)
const KINDS = [
  { kind: "memory", skip: false, make: (now, o = {}) => createMemorySessionStore(o.limits ?? LIMITS, now) },
  { kind: "postgres", skip: PG_SKIP, make: (now, o = {}) => pgStore(now, o) },
];
const fields = (n, extra = {}) => ({ userId: `u${n}`, accessToken: `access-${n}-${"x".repeat(20)}`,
  refreshToken: `refresh-${n}-${"y".repeat(20)}`, accessExpiresAt: 0, cookieName: `prazoai_sid_slot${n}abcde`.slice(0, 22), ...extra });

for (const K of KINDS) {
  test(`[${K.kind}] expiração por inatividade e idade; capacidade sem derrubar sessões`, { skip: K.skip }, async () => {
    if (K.kind === "postgres") await resetSchema();
    let t = 10_000_000;
    const store = K.make(() => t);
    const a = await store.create(fields(1));
    await store.create(fields(2));
    await store.create(fields(3));
    await assert.rejects(store.create(fields(4)), SessionCapacityError);
    t += 59_000;
    assert.ok(await store.get(a));                                       // atividade renova a inatividade
    t += 59_000;                                                         // as outras duas expiram
    await store.create(fields(5));
    assert.equal(await store.count(), 2);
    t += 300_000;
    assert.equal(await store.get(a), null);                              // idade máxima
    await store.sweep(true);
    assert.equal(await store.count(), 0);
  });

  test(`[${K.kind}] troca condicional por geração; remoção devolve o token a revogar`, { skip: K.skip }, async () => {
    if (K.kind === "postgres") await resetSchema();
    let t = 10_000_000;
    const store = K.make(() => t);
    const id = await store.create(fields(1));
    const s = await store.get(id);
    assert.equal(s.generation, 1);
    assert.equal(await store.updateTokens(id, 2, { accessToken: "x".repeat(20), refreshToken: "y".repeat(20), accessExpiresAt: 1 }), false);
    assert.equal(await store.updateTokens(id, 1, { accessToken: "novo-access-xxxxxxxx", refreshToken: "novo-refresh-yyyyyyy", accessExpiresAt: 5 }), true);
    assert.equal(await store.updateTokens(id, 1, { accessToken: "x".repeat(20), refreshToken: "y".repeat(20), accessExpiresAt: 1 }), false);
    const s2 = await store.get(id);
    assert.equal(s2.generation, 2);
    assert.equal(s2.accessToken, "novo-access-xxxxxxxx");
    assert.equal(s2.refreshToken, "novo-refresh-yyyyyyy");
    assert.equal(s2.accessExpiresAt, 5);
    assert.deepEqual(await store.delete(id), { accessToken: "novo-access-xxxxxxxx" });
    assert.equal(await store.delete(id), null);
    assert.equal(await store.get(id), null);
  });

  test(`[${K.kind}] publicação atômica do login: bilhete substituído, sessão encerrada, capacidade`, { skip: K.skip }, async () => {
    if (K.kind === "postgres") await resetSchema();
    let t = 10_000_000;
    const store = K.make(() => t);
    const cur = await store.create(fields(1, { browserId: "B".repeat(43) }));
    const current = { value: cur, name: fields(1).cookieName };
    // bilhete substituído por outro login com o mesmo cookie → cancelado
    const t1 = newTicket(); const t2 = newTicket();
    assert.equal(await store.attachPendingLogin(cur, t1), true);
    assert.equal(await store.attachPendingLogin(cur, t2), true);
    assert.deepEqual(await store.publishLogin({ current, ticket: t1, session: fields(2) }), { status: "cancelled" });
    // nome de cookie diferente → cancelado (sessão não pertence àquele cookie)
    assert.deepEqual(await store.publishLogin({ current: { value: cur, name: "outro" }, ticket: t2, session: fields(2) }),
      { status: "cancelled" });
    // capacidade: nada publicado, sessão atual intacta
    await store.create(fields(7)); await store.create(fields(8));
    assert.deepEqual(await store.publishLogin({ current, ticket: t2, session: fields(2) }), { status: "capacity" });
    assert.ok(await store.isLive(cur, current.name));
    // válido → cria a nova e encerra a atual na mesma operação
    await store.sweep(true);
    t += 61_000;                                                          // 7 e 8 expiram (cur também, então renova)
    assert.equal(await store.isLive(cur, current.name), false);
    const cur2 = await store.create(fields(3));
    const current2 = { value: cur2, name: fields(3).cookieName };
    const t3 = newTicket();
    await store.attachPendingLogin(cur2, t3);
    const r = await store.publishLogin({ current: current2, ticket: t3, session: fields(4) });
    assert.equal(r.status, "ok");
    assert.deepEqual(r.previousTokens, [fields(3).accessToken]);
    assert.equal(await store.isLive(cur2, current2.name), false);
    assert.ok(await store.isLive(r.id, fields(4).cookieName));
    // detach de bilhete alheio não altera nada; sem sessão atual (primeiro login) publica direto
    const r2 = await store.publishLogin({ current: null, ticket: newTicket(), session: fields(5) });
    assert.equal(r2.status, "ok");
    assert.deepEqual(r2.previousTokens, []);
  });

  test(`[${K.kind}] encerramento atômico: cookies observados (nome conferido) e todo o navegador`, { skip: K.skip }, async () => {
    if (K.kind === "postgres") await resetSchema();
    const t = 10_000_000;
    const store = K.make(() => t, { limits: { ...LIMITS, maxSessions: 10 } });
    const bid = "N".repeat(43);
    const a = await store.create(fields(1, { browserId: bid }));
    const b = await store.create(fields(2, { browserId: bid }));
    const c = await store.create(fields(3, { browserId: "O".repeat(43) }));
    const d = await store.create(fields(4));
    assert.deepEqual(await store.endSessions([{ value: d, name: "nome-errado" }], null), []);
    const tokens = await store.endSessions([{ value: d, name: fields(4).cookieName }], bid);
    assert.deepEqual(tokens.sort(), [fields(1).accessToken, fields(2).accessToken, fields(4).accessToken].sort());
    assert.equal(await store.get(a), null);
    assert.equal(await store.get(b), null);
    assert.ok(await store.get(c));                                         // outro navegador intacto
  });

  test(`[${K.kind}] lease de renovação: um por geração; liberação; expiração; troca de geração encerra o lease`, { skip: K.skip }, async () => {
    if (K.kind === "postgres") await resetSchema();
    let t = 10_000_000;
    const store = K.make(() => t);
    const id = await store.create(fields(1));
    assert.equal(await store.acquireRefresh(id, 2, "x", 1000), false);    // geração errada
    assert.equal(await store.acquireRefresh(id, 1, "A", 1000), true);
    assert.equal(await store.acquireRefresh(id, 1, "B", 1000), false);
    assert.deepEqual(await store.peek(id), { generation: 1, refreshing: true });
    await store.releaseRefresh(id, "B");                                    // dono errado: nada muda
    assert.equal(await store.acquireRefresh(id, 1, "B", 1000), false);
    await store.releaseRefresh(id, "A");
    assert.equal(await store.acquireRefresh(id, 1, "B", 1000), true);
    t += 1000;                                                              // lease vencido (instância caiu)
    assert.equal((await store.peek(id)).refreshing, false);
    assert.equal(await store.acquireRefresh(id, 1, "C", 1000), true);
    assert.equal(await store.updateTokens(id, 1, { accessToken: "a".repeat(20), refreshToken: "r".repeat(20), accessExpiresAt: 0 }), true);
    assert.deepEqual(await store.peek(id), { generation: 2, refreshing: false });
    assert.equal(await store.acquireRefresh(id, 2, "D", 1000), true);
  });
}

// ============================================================== PostgreSQL: repouso, chaves, esquema, reinício
test("[postgres] em repouso: sem id de sessão, id de navegador nem tokens em claro", { skip: PG_SKIP }, async () => {
  await resetSchema();
  const store = pgStore(() => 10_000_000);
  const bid = "Q".repeat(43);
  const id = await store.create(fields(1, { browserId: bid }));
  const rows = (await admin("SELECT * FROM prazoai_bff.sessions")).rows;
  assert.equal(rows.length, 1);
  const raw = JSON.stringify(rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) =>
    [k, Buffer.isBuffer(v) ? v.toString("latin1") + v.toString("hex") + v.toString("base64") : v]))));
  for (const secret of [id, bid, fields(1).accessToken, fields(1).refreshToken, "access-1", "refresh-1"]) {
    assert.equal(raw.includes(secret), false, "valor sensível gravado em claro");
  }
  assert.ok(rows[0].id_hash.equals(hashId(id)));
  assert.ok(rows[0].browser_hash.equals(hashId(bid)));
});

test("[postgres] cifra amarrada à linha e ao campo; adulteração ou chave desconhecida encerra a sessão", { skip: PG_SKIP }, async () => {
  await resetSchema();
  const store = pgStore(() => 10_000_000, { limits: { ...LIMITS, maxSessions: 10 } });
  const a = await store.create(fields(1));
  const b = await store.create(fields(2));
  // troca a cifra do access de B para a linha de A → falha de autenticação → sessão A some
  await admin(`UPDATE prazoai_bff.sessions SET access_token_enc = (SELECT access_token_enc FROM prazoai_bff.sessions WHERE id_hash = $2)
               WHERE id_hash = $1`, [hashId(a), hashId(b)]);
  assert.equal(await store.get(a), null);
  assert.equal((await admin("SELECT count(*)::int AS n FROM prazoai_bff.sessions WHERE id_hash = $1", [hashId(a)])).rows[0].n, 0);
  // rotação: chave nova com a anterior decifra; sem a anterior a sessão deixa de valer
  const rotated = pgStore(() => 10_000_000, { keys: { current: KEY_B, previous: KEY_A } });
  assert.equal((await rotated.get(b)).accessToken, fields(2).accessToken);
  const c = await rotated.create(fields(3));                              // cifrada com a chave nova
  const onlyNew = pgStore(() => 10_000_000, { keys: { current: KEY_B } });
  assert.equal((await onlyNew.get(c)).refreshToken, fields(3).refreshToken);
  assert.equal(await onlyNew.get(b), null);                               // ainda na chave antiga
});

test("[postgres] esquema ausente é recusado (sem criar nada); migrate é idempotente", { skip: PG_SKIP }, async () => {
  await admin("DROP SCHEMA IF EXISTS prazoai_bff CASCADE");
  const store = pgStore(() => 10_000_000);
  await assert.rejects(store.get("x".repeat(43)), SessionSchemaError);
  assert.equal((await admin("SELECT to_regnamespace('prazoai_bff') IS NULL AS ausente")).rows[0].ausente, true);
  const c = new pg.Client({ connectionString: DB_URL });
  await c.connect();
  try {
    assert.deepEqual(await migrate(c), { from: 0, to: BFF_SCHEMA_VERSION });
    assert.deepEqual(await migrate(c), { from: BFF_SCHEMA_VERSION, to: BFF_SCHEMA_VERSION });
    assert.equal(await currentVersion(c), BFF_SCHEMA_VERSION);
  } finally { await c.end(); }
  assert.equal(await store.get("x".repeat(43)), null);                    // agora pronto (verificação refeita)
});

test("[postgres] banco indisponível: erro neutro (503 no BFF), sem detalhes do driver", { skip: PG_SKIP }, async () => {
  const p = createSessionPool({ databaseUrl: "postgresql://ninguem:x@127.0.0.1:1/prazoai_test", poolMax: 1 });
  pools.push(p);
  const errors = [];
  const store = createPgSessionStore({ pool: p, limits: LIMITS, cipher: createSessionCipher({ current: KEY_A }),
    logger: { error: (...a) => errors.push(JSON.stringify(a)) } });
  await assert.rejects(store.get("x".repeat(43)), SessionStoreUnavailableError);
  assert.equal(errors.join("").includes("ninguem"), false);
});

// ============================================================== duas instâncias do BFF (dublê do backend)
const ORIGIN = "http://localhost:3000";
const ENV = { PRAZOAI_APP_ENV: "test", PRAZOAI_APP_ORIGIN: ORIGIN, PRAZOAI_COOKIE_INSECURE_LOCAL: "true",
  PRAZOAI_BFF_TIMEOUT_MS: "1000" };

/** Duas instâncias (pools separados) no mesmo banco, mesmo relógio e mesmo backend. */
function cluster({ wrap } = {}) {
  let t = 20_000_000;
  const clock = { now: () => t, advance: (ms) => { t += ms; } };
  const config = loadBffConfig(ENV);
  const backend = createFakeBackend();
  const fetchImpl = (u, i) => (wrap ? wrap(backend.fetch, u, i) : backend.fetch(u, i));
  const make = () => {
    const store = pgStore(clock.now, { limits: config.session });
    return { store, bff: createBff({ config, store, fetchImpl, now: clock.now, logger: quiet, refreshPollMs: 10 }) };
  };
  return { A: make(), B: make(), make, backend, clock, config };
}
function req(method, path, { body, cookie } = {}) {
  const h = new Headers({ "x-prazoai-csrf": "1", origin: ORIGIN });
  if (cookie) h.set("cookie", cookie);
  if (body) h.set("content-type", "application/json");
  return new Request(`${ORIGIN}${path}`, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
}
const creds = { email: "ana@exemplo.com", password: "Senha-123" };
function jar() {
  const m = new Map();
  return {
    apply(r) {
      for (const c of r.headers.getSetCookie()) {
        const [nv, ...attrs] = c.split(";");
        const i = nv.indexOf("=");
        if (attrs.some((x) => x.trim() === "Max-Age=0")) m.delete(nv.slice(0, i).trim());
        else m.set(nv.slice(0, i).trim(), nv.slice(i + 1));
      }
      return this;
    },
    header() { return [...m].map(([n, v]) => `${n}=${v}`).join("; "); },
    sid() { return [...m].find(([n]) => /_sid_/.test(n))?.[1]; },
  };
}
function gates() {
  const g = new Map();
  return {
    hold(path) { const x = { reached: deferred(), go: deferred(), count: 0 }; g.set(path, x); return x; },
    async wrap(fetch, u, i) {
      const path = new URL(u).pathname.replace("/api/v1", "");
      const x = g.get(path);
      if (x) { x.count += 1; if (x.count === 1) x.reached.resolve(); await x.go.promise; }
      return fetch(u, i);
    },
    clear(path) { g.delete(path); },
  };
}

test("[postgres] instâncias distintas: login em A vale em B; logout em B encerra em A; reinício preserva", { skip: PG_SKIP }, async () => {
  await resetSchema();
  const c = cluster();
  const j = jar();
  assert.equal(j.apply(await c.A.bff.login(req("POST", "/bff/auth/login", { body: creds }))).sid().length, 43);
  let r = await c.B.bff.session(req("GET", "/bff/session", { cookie: j.header() }));
  assert.deepEqual(await r.json(), { authenticated: true, user: c.backend.user });
  r = await c.B.bff.proxy(req("GET", "/bff/api/users/me", { cookie: j.header() }), "/users/me");
  assert.equal(r.status, 200);
  // "reinício": instância nova (pool novo) lê a mesma sessão; as antigas são descartadas
  await c.A.store.close();
  const C = c.make();
  r = await C.bff.session(req("GET", "/bff/session", { cookie: j.header() }));
  assert.equal((await r.json()).authenticated, true);
  // logout em B: a sessão some para todas as instâncias e é revogada no backend
  r = await c.B.bff.logout(req("POST", "/bff/auth/logout", { cookie: j.header() }));
  assert.equal(r.status, 204);
  assert.equal(c.backend.revoked, true);
  r = await C.bff.session(req("GET", "/bff/session", { cookie: j.header() }));
  assert.equal((await r.json()).authenticated, false);
  assert.equal((await admin("SELECT count(*)::int AS n FROM prazoai_bff.sessions")).rows[0].n, 0);
});

test("[postgres] renovação concorrente em duas instâncias: UM refresh; ambas seguem com o par novo", { skip: PG_SKIP }, async () => {
  await resetSchema();
  const g = gates();
  const c = cluster({ wrap: (f, u, i) => g.wrap(f, u, i) });
  const j = jar().apply(await c.A.bff.login(req("POST", "/bff/auth/login", { body: creds })));
  c.clock.advance(900_000);                                               // access token vencido
  const held = g.hold("/auth/refresh");
  const pa = c.A.bff.proxy(req("GET", "/bff/api/users/me", { cookie: j.header() }), "/users/me");
  const pa2 = c.A.bff.proxy(req("GET", "/bff/api/users/me", { cookie: j.header() }), "/users/me");
  await held.reached.promise;                                             // A detém o lease e está no backend
  const pb = c.B.bff.proxy(req("GET", "/bff/api/users/me", { cookie: j.header() }), "/users/me");
  await new Promise((r) => setTimeout(r, 80));                            // B aguarda a troca de geração
  held.go.resolve();
  const [ra, ra2, rb] = await Promise.all([pa, pa2, pb]);
  assert.deepEqual([ra.status, ra2.status, rb.status], [200, 200, 200]);
  assert.equal(c.backend.calls.filter((x) => x.path === "/auth/refresh").length, 1);
  assert.equal(c.backend.current.revoked, false);                         // sem reutilização detectada
  const s = await c.B.store.get(j.sid());
  assert.equal(s.generation, 2);
  assert.equal(s.accessToken, c.backend.current.access);
  // os pedidos ao backend depois da renovação usaram o access token novo
  const after = c.backend.calls.filter((x) => x.path === "/users/me");
  assert.ok(after.every((x) => x.headers.authorization === `Bearer ${c.backend.current.access}`));
});

test("[postgres] instância que caiu com o lease: outra assume depois do vencimento", { skip: PG_SKIP }, async () => {
  await resetSchema();
  const c = cluster();
  const j = jar().apply(await c.A.bff.login(req("POST", "/bff/auth/login", { body: creds })));
  c.clock.advance(900_000);
  assert.equal(await c.A.store.acquireRefresh(j.sid(), 1, "instancia-morta", 6000), true);
  const pending = c.B.bff.proxy(req("GET", "/bff/api/users/me", { cookie: j.header() }), "/users/me");
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(c.backend.calls.filter((x) => x.path === "/auth/refresh").length, 0);   // B respeita o lease
  c.clock.advance(6000);                                                  // lease vence
  const r = await pending;
  assert.equal(r.status, 200);
  assert.equal(c.backend.calls.filter((x) => x.path === "/auth/refresh").length, 1);
});

test("[postgres] login pendente em A × logout em B (mesmo navegador): logout vence, nada instalado", { skip: PG_SKIP }, async () => {
  await resetSchema();
  const g = gates();
  const c = cluster({ wrap: (f, u, i) => g.wrap(f, u, i) });
  const j = jar().apply(await c.A.bff.login(req("POST", "/bff/auth/login", { body: creds })));
  const held = g.hold("/auth/login");
  const pending = c.A.bff.login(req("POST", "/bff/auth/login", { body: creds, cookie: j.header() }));
  await held.reached.promise;
  const out = await c.B.bff.logout(req("POST", "/bff/auth/logout", { cookie: j.header() }));
  assert.equal(out.status, 204);
  held.go.resolve();
  const r = await pending;
  assert.equal(r.status, 409);
  assert.equal((await r.json()).error.code, "login_cancelled");
  assert.equal(r.headers.getSetCookie().some((x) => !x.includes("Max-Age=0")), false);    // nenhum cookie novo
  assert.equal((await admin("SELECT count(*)::int AS n FROM prazoai_bff.sessions")).rows[0].n, 0);
  assert.ok(c.backend.sessions.every((s) => s.revoked), "par da tentativa perdida revogado");
});

test("[postgres] login já publicado em A × logout em B durante a revogação: logout concluído não é revertido", { skip: PG_SKIP }, async () => {
  await resetSchema();
  const g = gates();
  const c = cluster({ wrap: (f, u, i) => g.wrap(f, u, i) });
  const j = jar().apply(await c.A.bff.login(req("POST", "/bff/auth/login", { body: creds })));
  const held = g.hold("/auth/logout");                                    // A para na revogação da sessão anterior
  const pending = c.A.bff.login(req("POST", "/bff/auth/login", { body: creds, cookie: j.header() }));
  await held.reached.promise;
  g.clear("/auth/logout");
  const out = await c.B.bff.logout(req("POST", "/bff/auth/logout", { cookie: j.header() }));   // só o cookie antigo + navegador
  assert.equal(out.status, 204);
  held.go.resolve();
  const r = await pending;
  assert.equal(r.status, 409);
  assert.equal((await admin("SELECT count(*)::int AS n FROM prazoai_bff.sessions")).rows[0].n, 0);
});

test("[postgres] logouts concorrentes em A e B: idempotentes; uma revogação por sessão", { skip: PG_SKIP }, async () => {
  await resetSchema();
  const c = cluster();
  const j = jar().apply(await c.A.bff.login(req("POST", "/bff/auth/login", { body: creds })));
  const [ra, rb] = await Promise.all([
    c.A.bff.logout(req("POST", "/bff/auth/logout", { cookie: j.header() })),
    c.B.bff.logout(req("POST", "/bff/auth/logout", { cookie: j.header() })),
  ]);
  assert.deepEqual([ra.status, rb.status], [204, 204]);
  assert.equal(c.backend.calls.filter((x) => x.path === "/auth/logout").length, 1);
  assert.equal(c.backend.revoked, true);
});

test("[postgres] isolamento: cada cookie usa só os próprios tokens, em qualquer instância", { skip: PG_SKIP }, async () => {
  await resetSchema();
  const c = cluster();
  const j1 = jar().apply(await c.A.bff.login(req("POST", "/bff/auth/login", { body: creds })));
  const t1 = c.backend.current.access;
  const j2 = jar().apply(await c.B.bff.login(req("POST", "/bff/auth/login", { body: creds })));
  const t2 = c.backend.current.access;
  assert.notEqual(j1.sid(), j2.sid());
  await c.B.bff.proxy(req("GET", "/bff/api/users/me", { cookie: j1.header() }), "/users/me");
  await c.A.bff.proxy(req("GET", "/bff/api/users/me", { cookie: j2.header() }), "/users/me");
  const used = c.backend.calls.filter((x) => x.path === "/users/me").map((x) => x.headers.authorization);
  assert.deepEqual(used, [`Bearer ${t1}`, `Bearer ${t2}`]);
  // logout de um não afeta o outro
  await c.A.bff.logout(req("POST", "/bff/auth/logout", { cookie: j1.header() }));
  const r = await c.A.bff.session(req("GET", "/bff/session", { cookie: j2.header() }));
  assert.equal((await r.json()).authenticated, true);
});

test("[postgres] armazenamento indisponível: proxy lança erro neutro; logout responde 503 e limpa só cookies observados", { skip: PG_SKIP }, async () => {
  await resetSchema();
  const c = cluster();
  const j = jar().apply(await c.A.bff.login(req("POST", "/bff/auth/login", { body: creds })));
  const p = createSessionPool({ databaseUrl: "postgresql://ninguem:x@127.0.0.1:1/prazoai_test", poolMax: 1 });
  pools.push(p);
  const down = createPgSessionStore({ pool: p, limits: c.config.session, cipher: createSessionCipher({ current: KEY_A }), logger: quiet });
  const bff = createBff({ config: c.config, store: down, fetchImpl: c.backend.fetch, logger: quiet });
  await assert.rejects(bff.proxy(req("GET", "/bff/api/users/me", { cookie: j.header() }), "/users/me"), SessionStoreUnavailableError);
  const r = await bff.logout(req("POST", "/bff/auth/logout", { cookie: j.header() }));
  assert.equal(r.status, 503);
  assert.equal((await r.json()).error.code, "session_store_unavailable");
  assert.ok(r.headers.getSetCookie().every((x) => x.includes("Max-Age=0")));
  // login com armazenamento fora do ar: par emitido pelo backend é revogado (nada órfão)
  await assert.rejects(bff.login(req("POST", "/bff/auth/login", { body: creds })), SessionStoreUnavailableError);
  assert.equal(c.backend.current.revoked, true);
});

test("[postgres] estresse: login em A × logout em B simultâneos — logout concluído nunca deixa sessão viva", { skip: PG_SKIP }, async () => {
  await resetSchema();
  const c = cluster();
  const outcomes = new Map();
  for (let i = 0; i < 40; i++) {
    const j = jar().apply(await c.A.bff.login(req("POST", "/bff/auth/login", { body: creds })));
    const [li, lo] = await Promise.all([
      c.A.bff.login(req("POST", "/bff/auth/login", { body: creds, cookie: j.header() })),
      c.B.bff.logout(req("POST", "/bff/auth/logout", { cookie: j.header() })),
    ]);
    assert.equal(lo.status, 204);
    outcomes.set(li.status, (outcomes.get(li.status) ?? 0) + 1);
    const live = (await admin("SELECT count(*)::int AS n FROM prazoai_bff.sessions")).rows[0].n;
    assert.equal(live, 0, `iteração ${i}: login ${li.status} sobreviveu ao logout concluído`);
  }
  assert.ok([...outcomes.keys()].every((s) => s === 409 || s === 200), JSON.stringify([...outcomes]));
});
