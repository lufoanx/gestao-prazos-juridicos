// Doc 27, §6 — PAPÉIS SEPARADOS com privilégios mínimos, num servidor PostgreSQL DESCARTÁVEL.
//
// Cria um banco e três papéis próprios (nomes e senhas aleatórios por execução), roda as migrations do
// backend (Alembic) e do BFF com o papel DONO, aplica backend/deploy/privilegios-minimos.sql (o mesmo
// arquivo do guia) e então:
//   - o FastAPI roda com o papel da API e o BFF com o papel do BFF, e os fluxos normais funcionam;
//   - a API não acessa o esquema das sessões do BFF; o BFF não acessa as tabelas do domínio;
//   - papéis de execução não executam DDL (migrations ficam com o dono).
// Ao final, o banco e os papéis são removidos.
//
// Requer PRAZOAI_TEST_PG_ADMIN_URL: superusuário de um servidor DESCARTÁVEL (host local ou o serviço
// `postgres` do CI). Sem ela, os testes são PULADOS — ou FALHAM com PRAZOAI_REQUIRE_PRIVILEGE_TESTS=1.
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { loadBffConfig } from "../../src/server/bff/config.mjs";
import { createBff } from "../../src/server/bff/manager.mjs";
import { createSessionStore } from "../../src/server/bff/instance.mjs";
import { migrate } from "../../src/server/bff/session-schema.mjs";

const ADMIN = process.env.PRAZOAI_TEST_PG_ADMIN_URL || "";
if (!ADMIN && process.env.PRAZOAI_REQUIRE_PRIVILEGE_TESTS === "1") {
  throw new Error("PRAZOAI_REQUIRE_PRIVILEGE_TESTS=1 exige PRAZOAI_TEST_PG_ADMIN_URL");
}
if (ADMIN && !["127.0.0.1", "localhost", "[::1]", "postgres"].includes(new URL(ADMIN).hostname)) {
  throw new Error("PRAZOAI_TEST_PG_ADMIN_URL deve apontar para um servidor descartável local");
}
const SKIP = ADMIN ? false : "PRAZOAI_TEST_PG_ADMIN_URL não definida";

const BACKEND_DIR = fileURLToPath(new URL("../../../backend", import.meta.url));
const SQL_FILE = fileURLToPath(new URL("../../../backend/deploy/privilegios-minimos.sql", import.meta.url));
const PYTHON = process.env.PRAZOAI_TEST_PYTHON || "python3";
const ORIGIN = "http://localhost:3000";
const PROXY_SECRET = randomBytes(32).toString("hex");
const PASSWORD = "Senha-de-teste-123";
const suffix = randomBytes(4).toString("hex");
const DB = `prazoai_test_priv_${suffix}`;
const ROLES = { owner: `prazoai_t_owner_${suffix}`, api: `prazoai_t_api_${suffix}`, bff: `prazoai_t_bff_${suffix}` };
const PW = Object.fromEntries(Object.keys(ROLES).map((k) => [k, randomBytes(18).toString("hex")]));
const PORT = 16000 + Math.floor(Math.random() * 900);
const BASE = `http://127.0.0.1:${PORT}`;

function urlFor(role, { driver = "postgresql" } = {}) {
  const u = new URL(ADMIN);
  u.username = ROLES[role];
  u.password = PW[role];
  u.pathname = `/${DB}`;
  const s = u.toString();
  return driver === "psycopg" ? s.replace(/^postgres(ql)?:/, "postgresql+psycopg:") : s;
}
async function as(role, fn) {
  const c = new pg.Client({ connectionString: role === "admin" ? ADMIN : urlFor(role) });
  await c.connect();
  try { return await fn(c); } finally { await c.end(); }
}
const denied = async (role, sql) => {
  await assert.rejects(as(role, (c) => c.query(sql)), (e) => e.code === "42501", `${role} deveria ser recusado: ${sql}`);
};
function run(args, env) {
  return new Promise((resolve) => {
    const p = spawn(PYTHON, args, { cwd: BACKEND_DIR, env: { PATH: process.env.PATH, ENVIRONMENT: "test", ...env },
      stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    p.stdout.on("data", (d) => { out += d; });
    p.stderr.on("data", (d) => { out += d; });
    p.on("close", (code) => resolve({ code, out }));
  });
}

let proc;
const stores = [];

before(async () => {
  if (!ADMIN) return;
  await as("admin", async (c) => {
    for (const [k, r] of Object.entries(ROLES)) await c.query(`CREATE ROLE ${r} LOGIN PASSWORD '${PW[k]}'`);
    await c.query(`CREATE DATABASE ${DB} OWNER ${ROLES.owner}`);
  });
  // (1) migrations do backend com o DONO
  const mig = await run(["-m", "alembic", "upgrade", "head"], { DATABASE_URL: urlFor("owner", { driver: "psycopg" }) });
  assert.equal(mig.code, 0, "alembic com o papel dono");
  // (2) esquema do BFF com o DONO
  await as("owner", (c) => migrate(c));
  // (3) privilégios mínimos (arquivo versionado do guia), também com o DONO
  const sql = readFileSync(SQL_FILE, "utf8").replaceAll("__OWNER__", ROLES.owner).replaceAll("__API__", ROLES.api)
    .replaceAll("__BFF__", ROLES.bff).replaceAll("__DB__", DB);
  await as("owner", (c) => c.query(sql));
  // FastAPI com o papel da API
  proc = spawn(PYTHON, ["-m", "uvicorn", "app.main:app", "--port", String(PORT), "--host", "127.0.0.1", "--no-proxy-headers"], {
    cwd: BACKEND_DIR,
    env: { PATH: process.env.PATH, ENVIRONMENT: "test", STORAGE: "postgres", DATABASE_URL: urlFor("api", { driver: "psycopg" }),
      AUTH_JWT_SECRET: randomBytes(32).toString("hex"), TRUSTED_PROXY_SECRET: PROXY_SECRET, LOG_LEVEL: "WARNING" },
    stdio: ["ignore", "ignore", "ignore"],
  });
  for (let i = 0; i < 150; i++) {
    try { if ((await fetch(`${BASE}/api/v1/health`)).ok) return; } catch { /* subindo */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("backend com o papel da API não subiu");
});

after(async () => {
  if (!ADMIN) return;
  proc?.kill("SIGTERM");
  await Promise.all(stores.map((s) => s.close().catch(() => {})));
  await new Promise((r) => setTimeout(r, 300));
  await as("admin", async (c) => {
    await c.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
    for (const r of Object.values(ROLES)) await c.query(`DROP ROLE IF EXISTS ${r}`);
  });
});

test("papéis: API sem acesso às sessões do BFF; BFF sem acesso ao domínio; sem DDL em execução", { skip: SKIP }, async () => {
  await denied("api", "SELECT 1 FROM prazoai_bff.sessions");
  await denied("api", "SELECT version FROM prazoai_bff.schema_version");
  await denied("bff", "SELECT 1 FROM prazoai.users");
  await denied("bff", "SELECT 1 FROM prazoai.auth_sessions");
  await denied("bff", "SELECT 1 FROM prazoai.deadlines");
  await denied("api", "CREATE TABLE prazoai.invasora (x int)");
  await denied("bff", "CREATE TABLE prazoai_bff.invasora (x int)");
  await denied("api", "CREATE SCHEMA invasor");
  await denied("bff", "CREATE SCHEMA invasor");
  await assert.rejects(as("api", (c) => c.query("DROP TABLE prazoai.users")), (e) => e.code === "42501");
  await assert.rejects(as("bff", (c) => c.query("TRUNCATE prazoai_bff.sessions")), (e) => e.code === "42501");
  // leituras normais de cada papel
  assert.equal((await as("api", (c) => c.query("SELECT version_num FROM prazoai.alembic_version"))).rows[0].version_num, "0003");
  assert.equal((await as("bff", (c) => c.query("SELECT version FROM prazoai_bff.schema_version"))).rows[0].version, 1);
});

test("migrations: o papel da API não as executa (sem alteração); a verificação somente leitura funciona", { skip: SKIP }, async () => {
  const down = await run(["-m", "alembic", "downgrade", "0002"], { DATABASE_URL: urlFor("api", { driver: "psycopg" }) });
  assert.notEqual(down.code, 0);
  assert.match(down.out, /InsufficientPrivilege|permission denied|must be owner/i);
  assert.equal((await as("owner", (c) => c.query("SELECT version_num FROM prazoai.alembic_version"))).rows[0].version_num, "0003");
  const check = await run(["-m", "app.db", "check"], { DATABASE_URL: urlFor("api", { driver: "psycopg" }) });
  assert.equal(check.code, 0, "check somente leitura com o papel da API");
  assert.equal(check.out.includes(PW.api), false);
  const purge = await run(["-m", "app.maintenance", "purge"], { STORAGE: "postgres", DATABASE_URL: urlFor("api", { driver: "psycopg" }) });
  assert.equal(purge.code, 0, "manutenção (DML) com o papel da API");
  // BFF: verificar o esquema funciona; migrar (DDL) não, com o papel de execução
  await assert.rejects(as("bff", (c) => c.query("ALTER TABLE prazoai_bff.sessions ADD COLUMN x int")), (e) => e.code === "42501");
});

test("operações normais com os papéis de execução (BFF + FastAPI)", { skip: SKIP }, async () => {
  let skew = 0;
  const now = () => Date.now() + skew;
  const config = loadBffConfig({ PRAZOAI_APP_ENV: "test", PRAZOAI_APP_ORIGIN: ORIGIN, PRAZOAI_COOKIE_INSECURE_LOCAL: "true",
    PRAZOAI_BACKEND_URL: BASE, PRAZOAI_PROXY_SECRET: PROXY_SECRET, PRAZOAI_TRUSTED_CLIENT_IP_HEADER: "x-test-client-ip",
    PRAZOAI_BFF_SESSION_STORE: "postgres", PRAZOAI_BFF_DATABASE_URL: urlFor("bff"),
    PRAZOAI_BFF_SESSION_KEY: randomBytes(32).toString("base64url") });
  const store = await createSessionStore(config, { now });
  stores.push(store);
  const bff = createBff({ config, store, now, logger: { info() {}, error() {} } });
  assert.equal((await (await fetch(`${BASE}/api/v1/health/ready`)).json()).status, "ready");

  let ipSeq = 1;
  function person() {
    const jar = new Map();
    const ip = `198.51.100.${ipSeq++}`;
    const apply = (r) => {
      for (const c of r.headers.getSetCookie()) {
        const [nv, ...attrs] = c.split(";");
        const i = nv.indexOf("=");
        if (attrs.some((x) => x.trim() === "Max-Age=0")) jar.delete(nv.slice(0, i).trim()); else jar.set(nv.slice(0, i).trim(), nv.slice(i + 1));
      }
      return r;
    };
    const headers = (body) => {
      const h = new Headers({ "x-prazoai-csrf": "1", origin: ORIGIN, "x-test-client-ip": ip });
      if (jar.size) h.set("cookie", [...jar].map(([n, v]) => `${n}=${v}`).join("; "));
      if (body !== undefined) h.set("content-type", "application/json");
      return h;
    };
    const p = {
      async call(method, path, body) {
        const r = apply(await bff.proxy(new Request(`${ORIGIN}/bff/api${path}`,
          { method, headers: headers(body), body: body === undefined ? undefined : JSON.stringify(body) }), path.split("?")[0]));
        const text = await r.text();
        return { status: r.status, body: text ? JSON.parse(text) : null };
      },
      async signup(name) {
        const email = `priv${randomBytes(4).toString("hex")}@exemplo.com`;
        const reg = await bff.register(new Request(`${ORIGIN}/bff/auth/register`, { method: "POST", headers: headers({}),
          body: JSON.stringify({ name, email, password: PASSWORD }) }));
        assert.equal(reg.status, 201);
        const r = apply(await bff.login(new Request(`${ORIGIN}/bff/auth/login`, { method: "POST", headers: headers({}),
          body: JSON.stringify({ email, password: PASSWORD }) })));
        assert.equal(r.status, 200);
        p.user = (await r.json()).user;
        return p;
      },
      async logout() { return apply(await bff.logout(new Request(`${ORIGIN}/bff/auth/logout`, { method: "POST", headers: headers() }))); },
      async session() { return (await bff.session(new Request(`${ORIGIN}/bff/session`, { headers: headers() }))).json(); },
    };
    return p;
  }

  const ana = await person().signup("Ana");
  const bia = await person().signup("Bia");
  assert.equal((await ana.call("PATCH", "/users/me", { name: "Ana Renomeada" })).status, 200);
  const office = await ana.call("POST", "/offices", { name: "Escritório Privilégios" });
  assert.equal(office.status, 201);
  const oid = office.body.office?.id ?? office.body.id;
  const inv = await ana.call("POST", `/offices/${oid}/invitations`, {});
  assert.equal(inv.status, 201);
  assert.equal((await bia.call("POST", "/invitations/accept", { token: inv.body.token })).status, 200);
  const D = (over) => ({ title: "Contestação", caseNumber: "0001234-56.2026", court: "TJSC", practiceArea: "Cível",
    startDate: "2026-11-01", dueDate: "2026-11-20", countingMode: "business", duration: 10, ...over });
  const office1 = await ana.call("POST", "/deadlines", D({ scope: "office", responsibleId: bia.user.id }));
  assert.equal(office1.status, 201);
  const personal = await bia.call("POST", "/deadlines", D({ scope: "personal" }));
  assert.equal(personal.status, 201);
  assert.equal((await bia.call("POST", `/deadlines/${office1.body.id}/comments`, { text: "Comentário" })).status, 201);
  assert.equal((await bia.call("GET", "/calendar?scope=personal&year=2026&month=11&perPage=50&page=1")).status, 200);
  const intimation = await bia.call("POST", "/intimations",
    { scope: "personal", fileName: "intimacao.pdf", sizeBytes: 2048, contentType: "application/pdf", receivedAt: "2026-11-01" });
  assert.equal(intimation.status, 201);
  assert.equal((await bia.call("GET", "/notifications?scope=office&perPage=20&page=1")).status, 200);
  // renovação (UPDATE de tokens no armazenamento do BFF + rotação no backend)
  skew += 16 * 60 * 1000;
  assert.equal((await bia.call("GET", "/users/me")).status, 200);
  // isolamento entre contas
  const anaList = await ana.call("GET", "/deadlines?scope=personal");
  assert.equal(anaList.status, 200);
  assert.equal(JSON.stringify(anaList.body).includes(personal.body.id), false);
  // logout
  assert.equal((await bia.logout()).status, 204);
  assert.equal((await bia.session()).authenticated, false);
  assert.equal((await ana.session()).authenticated, true);
});
