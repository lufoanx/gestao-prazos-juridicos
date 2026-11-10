// Etapa 6.3 — INTEGRAÇÃO REAL: prazos/calendário pelo BFF contra o FastAPI de verdade.
// Responsabilidades (prazos) são preparadas pelas APIs EXISTENTES do backend, com contas de teste —
// nenhuma rota de módulo futuro foi aberta no BFF para isso.
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { loadBffConfig } from "../../src/server/bff/config.mjs";
import { createMemorySessionStore } from "../../src/server/bff/session-store.mjs";
import { createBff } from "../../src/server/bff/manager.mjs";

const BACKEND_DIR = fileURLToPath(new URL("../../../backend", import.meta.url));
const PYTHON = process.env.PRAZOAI_TEST_PYTHON || "python3";
const PORT = 19950 + Math.floor(Math.random() * 40);
const BASE = `http://127.0.0.1:${PORT}`;
const ORIGIN = "http://localhost:3000";
const PROXY_SECRET = randomBytes(32).toString("hex");
const PASSWORD = "Senha-de-teste-123";
let proc;
const urls = [];

before(async () => {
  proc = spawn(PYTHON, ["-m", "uvicorn", "app.main:app", "--port", String(PORT), "--host", "127.0.0.1", "--no-proxy-headers"], {
    cwd: BACKEND_DIR,
    env: { ...process.env, ENVIRONMENT: "test", AUTH_JWT_SECRET: randomBytes(32).toString("hex"), TRUSTED_PROXY_SECRET: PROXY_SECRET, LOG_LEVEL: "WARNING" },
    stdio: ["ignore", "ignore", "pipe"],
  });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${BASE}/api/v1/health`)).ok) return; } catch { /* subindo */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("backend não subiu");
});
after(() => { proc?.kill("SIGTERM"); });

const config = loadBffConfig({ PRAZOAI_APP_ENV: "test", PRAZOAI_APP_ORIGIN: ORIGIN, PRAZOAI_COOKIE_INSECURE_LOCAL: "true",
  PRAZOAI_BACKEND_URL: BASE, PRAZOAI_PROXY_SECRET: PROXY_SECRET, PRAZOAI_TRUSTED_CLIENT_IP_HEADER: "x-test-client-ip" });
const bff = createBff({ config, store: createMemorySessionStore(config.session),
  fetchImpl: (url, init) => { urls.push(String(url)); return fetch(url, init); }, logger: { info() {} } });

let ipSeq = 1;
/** Um "navegador": pote de cookies próprio e IP encaminhado próprio. */
function browser() {
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
  const call = async (method, path, body) => {
    const reqInit = { method, headers: headers(body), body: body === undefined ? undefined : JSON.stringify(body) };
    const [pathname] = path.split("?");
    const r = apply(await bff.proxy(new Request(`${ORIGIN}/bff/api${path}`, reqInit), pathname));
    const text = await r.text();
    return { status: r.status, body: text ? JSON.parse(text) : null, headers: r.headers };
  };
  return {
    ip, call,
    async signup(name) {
      const email = `org${randomBytes(4).toString("hex")}@exemplo.com`;
      const reg = await bff.register(new Request(`${ORIGIN}/bff/auth/register`, { method: "POST", headers: headers({}), body: JSON.stringify({ name, email, password: PASSWORD }) }));
      assert.equal(reg.status, 201);
      const r = apply(await bff.login(new Request(`${ORIGIN}/bff/auth/login`, { method: "POST", headers: headers({}), body: JSON.stringify({ email, password: PASSWORD }) })));
      assert.equal(r.status, 200);
      this.user = (await r.json()).user;
      this.email = email;
      return this;
    },
    async lookup(token) {
      const r = await bff.publicInvitationLookup(new Request(`${ORIGIN}/bff/public/invitations/lookup`, { method: "POST", headers: headers({}), body: JSON.stringify({ token }) }));
      assert.equal(r.headers.getSetCookie().length, 0);
      return { status: r.status, body: await r.json() };
    },
  };
}

/** Prazo do escritório criado DIRETO no backend com a conta de teste (fixture de responsabilidade). */
async function createOfficeDeadline(email, responsibleId) {
  const login = await fetch(`${BASE}/api/v1/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password: PASSWORD }) });
  const { accessToken } = await login.json();
  const r = await fetch(`${BASE}/api/v1/deadlines`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ scope: "office", title: "Contestação", caseNumber: "0001234-56.2026", court: "TJSC", practiceArea: "Cível",
      startDate: "2026-11-09", dueDate: "2026-11-20", countingMode: "business", duration: 10, responsibleId }) });
  assert.equal(r.status, 201, await r.clone().text());
}

async function officeOf(admin, name = "Escritório Integrado") {
  const r = await admin.call("POST", "/offices", { name });
  assert.equal(r.status, 201);
  return r.body.office.id;
}

async function invite(admin, officeId, member) {
  const inv = await admin.call("POST", `/offices/${officeId}/invitations`, {});
  assert.equal(inv.status, 201);
  const acc = await member.call("POST", "/invitations/accept", { token: inv.body.token });
  assert.equal(acc.status, 200);
}


async function directToken(email) {
  const r = await fetch(`${BASE}/api/v1/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password: PASSWORD }) });
  return (await r.json()).accessToken;
}
/** Fixture: cria prazos DIRETO no backend (API existente), com a conta de teste. */
async function seed(email, scope, n, over = {}) {
  const token = await directToken(email);
  const ids = [];
  for (let i = 0; i < n; i++) {
    const r = await fetch(`${BASE}/api/v1/deadlines`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ scope, title: `Prazo ${String(i).padStart(3, "0")}`, caseNumber: "0001234-56.2026", court: "TJSC", practiceArea: "Cível",
        startDate: "2026-11-01", dueDate: "2026-11-20", countingMode: "business", duration: 10, ...over }) });
    assert.equal(r.status, 201, await r.clone().text());
    ids.push((await r.json()).id);
  }
  return ids;
}
const D = (over = {}) => ({ scope: "office", title: "Contestação", caseNumber: "0001234-56.2026", court: "TJSC", practiceArea: "Cível",
  startDate: "2026-11-01", dueDate: "2026-11-20", countingMode: "business", duration: 10, ...over });

test("real 6.3: prazo pessoal é privado, inclusive perante a administradora do escritório", async () => {
  const ana = await browser().signup("Ana");
  const oid = await officeOf(ana);
  const bia = await browser().signup("Bia");
  await invite(ana, oid, bia);
  const mine = await bia.call("POST", "/deadlines", D({ scope: "personal" }));
  assert.equal(mine.status, 201);
  assert.equal((await ana.call("GET", `/deadlines/${mine.body.id}`)).status, 404);
  assert.equal((await ana.call("GET", "/deadlines?scope=personal")).body.total, 0);
  assert.equal((await bia.call("GET", "/deadlines?scope=personal")).body.total, 1);
});

test("real 6.3: visibilidade assigned × all e responsáveis válidos", async () => {
  const ana = await browser().signup("Ana");
  const oid = await officeOf(ana);
  const bia = await browser().signup("Bia");
  const caio = await browser().signup("Caio");
  await invite(ana, oid, bia);
  await invite(ana, oid, caio);
  const forCaio = await ana.call("POST", "/deadlines", D({ responsibleId: caio.user.id }));
  const forBia = await ana.call("POST", "/deadlines", D({ responsibleId: bia.user.id }));
  assert.equal((await bia.call("GET", `/deadlines/${forCaio.body.id}`)).status, 404);
  assert.equal((await bia.call("GET", `/deadlines/${forBia.body.id}`)).status, 200);
  assert.equal((await bia.call("GET", "/deadlines?scope=office")).body.total, 1);       // totais autorizados
  assert.equal((await ana.call("GET", "/deadlines?scope=office")).body.total, 2);
  const deleg = await bia.call("POST", "/deadlines", D({ responsibleId: caio.user.id }));
  assert.equal(deleg.status, 403);
  assert.equal(deleg.body.error.code, "delegation_not_allowed");
  const outsider = await browser().signup("Zeca");
  const bad = await ana.call("POST", "/deadlines", D({ responsibleId: outsider.user.id }));
  assert.equal(bad.status, 422);
  // Membros (projeção pública) servem para nomes, sem e-mails.
  const members = await bia.call("GET", `/offices/${oid}/members`);
  assert.equal(members.body.projection, "public");
});

test("real 6.3: filtros, ordenação e paginação no servidor via query controlada", async () => {
  const ana = await browser().signup("Ana");
  await seed(ana.email, "personal", 25);
  await seed(ana.email, "personal", 1, { title: "Réplica especial", dueDate: "2026-12-05" });
  let r = await ana.call("GET", "/deadlines?scope=personal&perPage=10&page=3&sort=title&dir=asc");
  assert.equal(r.status, 200);
  assert.equal(r.body.total, 26);
  assert.equal(r.body.pageCount, 3);
  assert.equal(r.body.items.length, 6);
  r = await ana.call("GET", "/deadlines?scope=personal&sort=title&dir=desc&perPage=1");
  assert.equal(r.body.items[0].title, "Réplica especial");
  r = await ana.call("GET", "/deadlines?scope=personal&q=r%C3%A9plica");
  assert.equal(r.body.total, 1);
  r = await ana.call("GET", "/deadlines?scope=personal&dueFrom=2026-12-01&dueTo=2026-12-31");
  assert.equal(r.body.total, 1);
  r = await ana.call("GET", "/deadlines?scope=personal&perPage=1000");
  assert.equal(r.status, 422);                                                           // limite preservado (BFF)
  r = await ana.call("GET", "/deadlines?scope=personal&scope=office");
  assert.equal(r.status, 422);
});

test("real 6.3: conflito de versão em duas abas e X-Current-Version", async () => {
  const ana = await browser().signup("Ana");
  const d = (await ana.call("POST", "/deadlines", D({ scope: "personal" }))).body;
  assert.equal((await ana.call("PATCH", `/deadlines/${d.id}`, { version: d.version, title: "Aba A" })).status, 200);
  const stale = await ana.call("PATCH", `/deadlines/${d.id}`, { version: d.version, title: "Aba B" });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error.code, "version_conflict");
  assert.equal(stale.headers.get("x-current-version"), "2");
  assert.equal((await ana.call("GET", `/deadlines/${d.id}`)).body.title, "Aba A");          // nada sobrescrito
});

test("real 6.3: transições e responsável inativo na reabertura", async () => {
  const ana = await browser().signup("Ana");
  const oid = await officeOf(ana);
  const bia = await browser().signup("Bia");
  await invite(ana, oid, bia);
  const d = (await ana.call("POST", "/deadlines", D({ responsibleId: bia.user.id }))).body;
  let r = await ana.call("POST", `/deadlines/${d.id}/status`, { version: 1, status: "completed" });
  assert.equal(r.status, 200);
  r = await ana.call("POST", `/deadlines/${d.id}/status`, { version: 2, status: "cancelled" });
  assert.equal(r.body.error.code, "invalid_transition");
  assert.equal((await ana.call("POST", `/offices/${oid}/members/${bia.user.id}/remove`, {})).status, 204);
  r = await ana.call("POST", `/deadlines/${d.id}/status`, { version: 2, status: "open" });
  assert.equal(r.body.error.code, "responsible_inactive");
  r = await ana.call("POST", `/deadlines/${d.id}/status`, { version: 2, status: "open", responsibleId: ana.user.id });
  assert.equal(r.status, 200);
  assert.equal(r.body.responsibleId, ana.user.id);
});

test("real 6.3: transferência com consentimentos; intimação vinculada exige confirmação específica", async () => {
  const ana = await browser().signup("Ana");
  const oid = await officeOf(ana);
  const plain = (await ana.call("POST", "/deadlines", D({ scope: "personal" }))).body;
  let r = await ana.call("POST", `/deadlines/${plain.id}/transfer`, { version: 1, officeId: oid, confirmSharing: false });
  assert.equal(r.status, 422);
  r = await ana.call("POST", `/deadlines/${plain.id}/transfer`, { version: 1, officeId: oid, confirmSharing: true });
  assert.equal(r.status, 200);
  assert.match(r.body.notice, /comentários e histórico/);
  // Fixture: prazo pessoal criado a partir de uma intimação, pela API EXISTENTE do backend.
  const token = await directToken(ana.email);
  const H = { "content-type": "application/json", authorization: `Bearer ${token}` };
  const intim = await (await fetch(`${BASE}/api/v1/intimations`, { method: "POST", headers: H,
    body: JSON.stringify({ scope: "personal", fileName: "intimacao.pdf", sizeBytes: 100, contentType: "application/pdf", receivedAt: "2026-11-01" }) })).json();
  const conf = await (await fetch(`${BASE}/api/v1/intimations/${intim.id}/confirm`, { method: "POST", headers: H,
    body: JSON.stringify({ version: 1, title: "Da intimação", caseNumber: "0001234-56.2026", court: "TJSC", practiceArea: "Cível",
      startDate: "2026-11-01", dueDate: "2026-11-20", countingMode: "business", duration: 10 }) })).json();
  const linkedId = conf.deadline.id;
  r = await ana.call("POST", `/deadlines/${linkedId}/transfer`, { version: 1, officeId: oid, confirmSharing: true });
  assert.equal(r.status, 409);
  assert.equal(r.body.error.code, "linked_intimation_requires_consent");
  r = await ana.call("POST", `/deadlines/${linkedId}/transfer`, { version: 1, officeId: oid, confirmSharing: true, shareLinkedIntimation: true });
  assert.equal(r.status, 200);
  assert.equal((await ana.call("GET", "/intimations")).status, 404);                     // rotas de intimação NÃO abertas
});

test("real 6.3: calendário com mais resultados que uma página; contagens do mês inteiro", async () => {
  const ana = await browser().signup("Ana");
  await seed(ana.email, "personal", 130);
  const first = await ana.call("GET", "/calendar?scope=personal&year=2026&month=11&perPage=50&page=1");
  assert.equal(first.status, 200);
  assert.equal(first.body.total, 130);
  assert.equal(first.body.pageCount, 3);
  assert.equal(first.body.items.length, 50);
  assert.equal(first.body.countsByDay["2026-11-20"], 130);
  const ids = new Set();
  let page = 1;
  for (;;) {
    const r = await ana.call("GET", `/calendar?scope=personal&year=2026&month=11&perPage=50&page=${page}`);
    r.body.items.forEach((i) => ids.add(i.id));
    if (!r.body.hasNextPage) break;
    page = r.body.nextPage;
  }
  assert.equal(ids.size, 130);
  assert.equal((await ana.call("GET", "/calendar?scope=personal&year=2026&month=11&perPage=501")).status, 422);
});

test("real 6.3: comentários e histórico paginados, sem referência protegida exposta", async () => {
  const ana = await browser().signup("Ana");
  const oid = await officeOf(ana);
  const bia = await browser().signup("Bia");
  await invite(ana, oid, bia);
  const d = (await ana.call("POST", "/deadlines", D({ responsibleId: bia.user.id }))).body;
  for (let i = 0; i < 3; i++) assert.equal((await bia.call("POST", `/deadlines/${d.id}/comments`, { text: `Comentário ${i}` })).status, 201);
  const p2 = await bia.call("GET", `/deadlines/${d.id}/comments?page=2&perPage=2`);
  assert.equal(p2.body.total, 3);
  assert.deepEqual(p2.body.items.map((c) => c.text), ["Comentário 2"]);
  const h = await bia.call("GET", `/deadlines/${d.id}/history?page=1&perPage=50`);
  assert.equal(h.status, 200);
  assert.ok(h.body.items.every((e) => typeof e.actorId === "string"));
  assert.equal((await bia.call("GET", `/deadlines/${d.id}/history?page=1&perPage=50&x=1`)).status, 422);
});

test("real 6.3: perda de deadline.read com a mesma sessão → 403/404 sem logout", async () => {
  const ana = await browser().signup("Ana");
  const oid = await officeOf(ana);
  const bia = await browser().signup("Bia");
  await invite(ana, oid, bia);
  const d = (await ana.call("POST", "/deadlines", D({ responsibleId: bia.user.id }))).body;
  assert.equal((await bia.call("GET", `/deadlines/${d.id}`)).status, 200);
  await ana.call("PATCH", `/offices/${oid}/members/${bia.user.id}`, { permissions: ["deadline.create"] });
  assert.equal((await bia.call("GET", `/deadlines/${d.id}`)).status, 404);
  assert.equal((await bia.call("GET", "/deadlines?scope=office")).status, 403);
  assert.equal((await bia.call("GET", "/users/me")).status, 200);                        // sessão continua válida
});
