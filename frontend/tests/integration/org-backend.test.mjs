// Etapa 6.2 — INTEGRAÇÃO REAL: BFF (proxy autenticado + consulta pública) contra o FastAPI de verdade.
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
const PORT = 19600 + Math.floor(Math.random() * 300);
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
    const r = apply(await bff.proxy(new Request(`${ORIGIN}/bff/api${path}`, reqInit), path));
    const text = await r.text();
    return { status: r.status, body: text ? JSON.parse(text) : null };
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

test("real 6.2: criar escritório e bloquear um segundo", async () => {
  const ana = await browser().signup("Ana");
  assert.deepEqual((await ana.call("GET", "/memberships/me")).body, { office: null, membership: null });
  const oid = await officeOf(ana);
  const me = (await ana.call("GET", "/memberships/me")).body;
  assert.equal(me.office.id, oid);
  assert.ok(me.membership.permissions.includes("office.manage"));
  const second = await ana.call("POST", "/offices", { name: "Outro" });
  assert.equal(second.status, 409);
  assert.equal(second.body.error.code, "already_in_office");
});

test("real 6.2: convite — consulta pública, aceite, estados e token fora de URLs", async () => {
  const ana = await browser().signup("Ana");
  const oid = await officeOf(ana, "Silva Advocacia");
  const inv = await ana.call("POST", `/offices/${oid}/invitations`, { roleLabel: "Associada" });
  const token = inv.body.token;
  const visitor = browser();
  assert.deepEqual((await visitor.lookup(token)).body, { state: "valid", officeName: "Silva Advocacia" });   // sem sessão
  const bia = await browser().signup("Bia");
  const acc = await bia.call("POST", "/invitations/accept", { token });
  assert.equal(acc.status, 200);
  assert.equal(acc.body.office.id, oid);
  assert.equal((await visitor.lookup(token)).body.state, "used");
  const again = await (await browser().signup("Caio")).call("POST", "/invitations/accept", { token });
  assert.equal(again.status, 410);
  const revoked = await ana.call("POST", `/offices/${oid}/invitations`, {});
  await ana.call("POST", `/offices/${oid}/invitations/${revoked.body.id}/revoke`, {});
  assert.equal((await visitor.lookup(revoked.body.token)).body.state, "revoked");
  assert.equal((await visitor.lookup("x".repeat(43))).body.state, "invalid");
  assert.ok(urls.every((u) => !u.includes(token) && !u.includes(revoked.body.token)));           // só no corpo
});

test("real 6.2: projeção pública sem campos administrativos; admin vê a administrativa", async () => {
  const ana = await browser().signup("Ana");
  const oid = await officeOf(ana);
  const bia = await browser().signup("Bia");
  await invite(ana, oid, bia);
  const pub = await bia.call("GET", `/offices/${oid}/members`);
  assert.equal(pub.body.projection, "public");
  for (const m of pub.body.members) assert.deepEqual(Object.keys(m).sort(), ["name", "practiceAreas", "roleLabel", "userId"]);
  const adm = await ana.call("GET", `/offices/${oid}/members`);
  assert.equal(adm.body.projection, "admin");
  assert.ok(adm.body.members.every((m) => "email" in m && "permissions" in m));
});

test("real 6.2: delegação limitada, gestor não altera gestor/admin, último administrador preservado", async () => {
  const ana = await browser().signup("Ana");
  const oid = await officeOf(ana);
  const bia = await browser().signup("Bia");
  const caio = await browser().signup("Caio");
  await invite(ana, oid, bia);
  await invite(ana, oid, caio);
  const MANAGER = ["deadline.read", "deadline.create", "deadline.edit", "deadline.complete", "team.manage"];
  assert.equal((await ana.call("PATCH", `/offices/${oid}/members/${bia.user.id}`, { permissions: MANAGER })).status, 200);
  let r = await bia.call("PATCH", `/offices/${oid}/members/${caio.user.id}`, { permissions: [...MANAGER, "office.manage"] });
  assert.equal(r.status, 403);
  assert.equal(r.body.error.code, "delegation_not_allowed");
  r = await bia.call("PATCH", `/offices/${oid}/members/${ana.user.id}`, { roleLabel: "Estagiária" });
  assert.equal(r.status, 403);
  r = await bia.call("PATCH", `/offices/${oid}/members/${caio.user.id}`, { roleLabel: "Sócio sênior" });   // cargo não concede poder
  assert.equal(r.status, 200);
  assert.equal((await caio.call("GET", `/offices/${oid}/join-code`)).status, 403);
  r = await ana.call("POST", `/offices/${oid}/leave`, {});
  assert.equal(r.status, 409);
  assert.equal(r.body.error.code, "successor_required");
  assert.equal((await ana.call("POST", `/offices/${oid}/leave`, { successorUserId: caio.user.id })).status, 204);
  assert.equal((await caio.call("GET", "/memberships/me")).body.membership.permissions.includes("office.manage"), true);
  assert.deepEqual((await ana.call("GET", "/memberships/me")).body, { office: null, membership: null });
});

test("real 6.2: solicitações — pedir, aprovar, rejeitar, cancelar e cancelamento das demais", async () => {
  const ana = await browser().signup("Ana");
  const oid = await officeOf(ana, "Escritório A");
  const zeca = await browser().signup("Zeca");
  const oid2 = await officeOf(zeca, "Escritório B");
  const code = (await ana.call("GET", `/offices/${oid}/join-code`)).body.joinCode;
  const code2 = (await zeca.call("GET", `/offices/${oid2}/join-code`)).body.joinCode;
  const dani = await browser().signup("Dani");
  const r1 = await dani.call("POST", "/join-requests", { joinCode: code });
  const r2 = await dani.call("POST", "/join-requests", { joinCode: code2 });
  assert.equal(r1.status, 201);
  assert.equal(r1.body.officeName, "Escritório A");
  const pending = (await ana.call("GET", `/offices/${oid}/join-requests`)).body;
  assert.equal(pending[0].requester.email, dani.email);
  assert.equal((await ana.call("POST", `/offices/${oid}/join-requests/${r1.body.id}/approve`, {})).status, 200);
  const mine = (await dani.call("GET", "/join-requests/me")).body;
  assert.equal(mine.find((x) => x.id === r1.body.id).status, "approved");
  assert.equal(mine.find((x) => x.id === r2.body.id).status, "cancelled");                    // limite de um escritório
  const eva = await browser().signup("Eva");
  const r3 = await eva.call("POST", "/join-requests", { joinCode: code });
  assert.equal((await ana.call("POST", `/offices/${oid}/join-requests/${r3.body.id}/reject`, {})).status, 200);
  const r4 = await eva.call("POST", "/join-requests", { joinCode: code });
  assert.equal((await eva.call("POST", `/join-requests/${r4.body.id}/cancel`, {})).body.status, "cancelled");
  const rotated = await ana.call("POST", `/offices/${oid}/join-code/rotate`, {});
  assert.notEqual(rotated.body.joinCode, code);
  assert.equal((await eva.call("POST", "/join-requests", { joinCode: code })).status, 404);    // código antigo
});

test("real 6.2: remoção com reatribuição e perda imediata de acesso com a mesma sessão", async () => {
  const ana = await browser().signup("Ana");
  const oid = await officeOf(ana);
  const bia = await browser().signup("Bia");
  await invite(ana, oid, bia);
  await createOfficeDeadline(ana.email, bia.user.id);                                          // responsabilidade em aberto
  let r = await ana.call("POST", `/offices/${oid}/members/${bia.user.id}/remove`, {});
  assert.equal(r.status, 409);
  assert.equal(r.body.error.code, "reassign_required");
  assert.equal((await bia.call("GET", `/offices/${oid}`)).status, 200);                       // nada mudou ainda
  r = await ana.call("POST", `/offices/${oid}/members/${bia.user.id}/remove`, { reassignTo: ana.user.id });
  assert.equal(r.status, 204);
  assert.deepEqual((await bia.call("GET", "/memberships/me")).body, { office: null, membership: null });
  assert.equal((await bia.call("GET", `/offices/${oid}`)).status, 404);                       // mesma sessão, sem acesso
  assert.equal((await bia.call("GET", `/offices/${oid}/members`)).status, 404);
});

test("real 6.2: perda de permissão vale na próxima requisição (mesma sessão)", async () => {
  const ana = await browser().signup("Ana");
  const oid = await officeOf(ana);
  const bia = await browser().signup("Bia");
  await invite(ana, oid, bia);
  const MANAGER = ["deadline.read", "deadline.create", "deadline.edit", "deadline.complete", "team.manage"];
  await ana.call("PATCH", `/offices/${oid}/members/${bia.user.id}`, { permissions: MANAGER });
  assert.equal((await bia.call("GET", `/offices/${oid}/join-code`)).status, 200);
  await ana.call("PATCH", `/offices/${oid}/members/${bia.user.id}`, { permissions: ["deadline.read"] });
  assert.equal((await bia.call("GET", `/offices/${oid}/join-code`)).status, 403);
  assert.equal((await bia.call("GET", `/offices/${oid}/members`)).body.projection, "public");
});
