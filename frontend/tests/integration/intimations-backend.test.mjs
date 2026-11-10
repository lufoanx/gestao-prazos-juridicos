// Etapa 6.4 — INTEGRAÇÃO REAL: intimações e notificações pelo BFF contra o FastAPI de verdade.
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
const PORT = 19900 + Math.floor(Math.random() * 40);
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


const META = (over = {}) => ({ scope: "office", fileName: "intimacao.pdf", sizeBytes: 2048, contentType: "application/pdf", receivedAt: "2026-11-01", ...over });
const FINAL = (over = {}) => ({ title: "Contestação", caseNumber: "0001234-56.2026", court: "TJSC", practiceArea: "Cível", priority: "normal",
  startDate: "2026-11-01", dueDate: "2026-11-20", countingMode: "business", duration: 10, ...over });

async function team() {
  const ana = await browser().signup("Ana");
  const oid = await officeOf(ana);
  const bia = await browser().signup("Bia");
  const caio = await browser().signup("Caio");
  await invite(ana, oid, bia);
  await invite(ana, oid, caio);
  return { ana, bia, caio, oid };
}

test("real 6.4: registro só de metadados; pessoal privado inclusive para a administradora", async () => {
  const ana = await browser().signup("Ana");
  const oid = await officeOf(ana);
  const bia = await browser().signup("Bia");
  await invite(ana, oid, bia);
  const r = await bia.call("POST", "/intimations", META({ scope: "personal" }));
  assert.equal(r.status, 201);
  assert.equal(r.body.file.storage, "not_stored");
  assert.equal(r.body.processing.status, "not_available");
  assert.equal(r.body.status, "awaiting_review");
  assert.equal(r.body.suggestion, null);
  assert.equal((await ana.call("GET", `/intimations/${r.body.id}`)).status, 404);
  assert.equal((await ana.call("GET", "/intimations?scope=personal")).body.total, 0);
  assert.equal((await bia.call("GET", "/intimations?scope=personal")).body.total, 1);
  const bytes = await bia.call("POST", "/intimations", { ...META({ scope: "personal" }), content: "JVBERi0xLjQ=" });
  assert.equal(bytes.status, 422);                                                      // conteúdo do PDF é recusado pelo contrato
});

test("real 6.4: assigned × all e leitura pelo responsável ATUAL do prazo após reatribuição", async () => {
  const { ana, bia, caio } = await team();
  const i = (await ana.call("POST", "/intimations", META({ suggestedResponsibleId: bia.user.id }))).body;
  assert.equal((await bia.call("GET", `/intimations/${i.id}`)).status, 200);            // sugerida
  assert.equal((await caio.call("GET", `/intimations/${i.id}`)).status, 404);           // assigned, sem vínculo
  assert.equal((await caio.call("GET", "/intimations?scope=office")).body.total, 0);
  const c = await ana.call("POST", `/intimations/${i.id}/confirm`, { version: i.version, ...FINAL({ responsibleId: bia.user.id }) });
  assert.equal(c.status, 201);
  assert.equal(c.body.created, true);
  const d = c.body.deadline;
  assert.equal((await bia.call("GET", `/intimations/${i.id}`)).status, 200);            // responsável atual
  await ana.call("PATCH", `/deadlines/${d.id}`, { version: d.version, responsibleId: caio.user.id });
  assert.equal((await bia.call("GET", `/intimations/${i.id}`)).status, 404);            // sugestão antiga não concede
  const asCaio = await caio.call("GET", `/intimations/${i.id}`);
  assert.equal(asCaio.status, 200);
  assert.equal(asCaio.body.deadlineId, d.id);
});

test("real 6.4: vínculo existente sem deadlineId legível; histórico sem identificador protegido", async () => {
  const { ana, bia, caio } = await team();
  const i = (await bia.call("POST", "/intimations", META({ suggestedResponsibleId: bia.user.id }))).body;
  const c = await ana.call("POST", `/intimations/${i.id}/confirm`, { version: i.version, ...FINAL({ responsibleId: caio.user.id }) });
  assert.equal(c.status, 201);
  const asBia = await bia.call("GET", `/intimations/${i.id}`);                           // autora, visibilidade assigned
  assert.equal(asBia.status, 200);
  assert.equal(asBia.body.linked, true);
  assert.equal(asBia.body.deadlineId, null);
  const h = await bia.call("GET", `/intimations/${i.id}/history?page=1&perPage=50`);
  const confirmed = h.body.items.find((e) => e.action === "confirmed");
  assert.equal(confirmed.details.deadlineId, null);
  assert.equal(confirmed.details.deadlineIdHidden, true);
  assert.ok(!JSON.stringify(h.body).includes(c.body.deadline.id));
  const again = await bia.call("POST", `/intimations/${i.id}/confirm`, { version: asBia.body.version, ...FINAL() });
  assert.equal(again.status, 409);
  assert.equal(again.body.error.code, "already_reviewed");
  assert.ok(!JSON.stringify(again.body).includes(c.body.deadline.id));                  // sem revelar o id
});

test("real 6.4: rascunho com null explícito × omissão; conflito de versão", async () => {
  const ana = await browser().signup("Ana");
  const i = (await ana.call("POST", "/intimations", META({ scope: "personal" }))).body;
  let r = await ana.call("PATCH", `/intimations/${i.id}`, { version: i.version, title: "Réplica", agendaTime: "09:30", duration: 5 });
  assert.equal(r.status, 200);
  r = await ana.call("PATCH", `/intimations/${i.id}`, { version: r.body.version, agendaTime: null });
  assert.equal(r.body.draft.agendaTime, null);                                          // null limpa
  assert.equal(r.body.draft.title, "Réplica");                                          // omitido mantém
  assert.equal(r.body.draft.duration, 5);
  const stale = await ana.call("PATCH", `/intimations/${i.id}`, { version: i.version, title: "Aba velha" });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error.code, "version_conflict");
  assert.equal((await ana.call("GET", `/intimations/${i.id}`)).body.draft.title, "Réplica");
});

test("real 6.4: confirmação explícita cria um prazo; repetir retorna 200 sem duplicar", async () => {
  const ana = await browser().signup("Ana");
  const i = (await ana.call("POST", "/intimations", META({ scope: "personal" }))).body;
  const incomplete = await ana.call("POST", `/intimations/${i.id}/confirm`, { version: i.version, title: "Só título" });
  assert.equal(incomplete.status, 422);                                                 // nada é completado pelo servidor
  const first = await ana.call("POST", `/intimations/${i.id}/confirm`, { version: i.version, ...FINAL() });
  assert.equal(first.status, 201);
  assert.equal(first.body.created, true);
  assert.equal(first.body.deadline.reviewed, true);
  const second = await ana.call("POST", `/intimations/${i.id}/confirm`, { version: i.version, ...FINAL() });
  assert.equal(second.status, 200);
  assert.equal(second.body.created, false);
  assert.equal(second.body.deadline.id, first.body.deadline.id);
  assert.equal((await ana.call("GET", "/deadlines?scope=personal")).body.total, 1);
});

test("real 6.4: descarte e estados terminais", async () => {
  const ana = await browser().signup("Ana");
  const i = (await ana.call("POST", "/intimations", META({ scope: "personal" }))).body;
  const d = await ana.call("POST", `/intimations/${i.id}/discard`, { version: i.version });
  assert.equal(d.status, 200);
  assert.equal(d.body.status, "discarded");
  for (const [method, path, body] of [["POST", "confirm", { version: d.body.version, ...FINAL() }], ["POST", "discard", { version: d.body.version }],
    ["PATCH", "", { version: d.body.version, title: "Título válido" }]]) {
    const r = await ana.call(method, `/intimations/${i.id}${path ? `/${path}` : ""}`, body);
    assert.equal(r.status, 409, `${path}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.error.code, "invalid_state", path);
  }
  assert.equal((await ana.call("GET", "/intimations?scope=personal")).body.total, 0);    // descartadas fora da lista padrão
  assert.equal((await ana.call("GET", "/intimations?scope=personal&status=discarded")).body.total, 1);
});

test("real 6.4: recusa deixar pendência sem responsável operacional", async () => {
  const { ana, bia, caio, oid } = await team();
  // Bia (visibilidade assigned) só pode sugerir a si mesma; ao sair, a pendência vai para Caio.
  const created = await bia.call("POST", "/intimations", META({ suggestedResponsibleId: bia.user.id }));
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const i = created.body;
  const before = await ana.call("GET", `/intimations/${i.id}`);
  assert.equal(before.status, 200, `antes: ${JSON.stringify(before.body)}`);
  const needs = await ana.call("POST", `/offices/${oid}/members/${bia.user.id}/remove`, {});
  assert.equal(needs.body.error.code, "reassign_required");
  assert.equal((await ana.call("POST", `/offices/${oid}/members/${bia.user.id}/remove`, { reassignTo: caio.user.id })).status, 204);
  const got = await ana.call("GET", `/intimations/${i.id}`);
  assert.equal(got.status, 200, JSON.stringify(got.body));
  const cur = got.body;
  const r = await ana.call("PATCH", `/intimations/${i.id}`, { version: cur.version, suggestedResponsibleId: null });
  assert.equal(r.status, 409, JSON.stringify(r.body));
  assert.equal(r.body.error.code, "operational_responsible_required");
  assert.equal((await ana.call("GET", `/intimations/${i.id}`)).body.suggestedResponsibleId, caio.user.id);
});

test("real 6.4: notificações — contagem do servidor, marcar todas além da 1ª página e só no ambiente escolhido", async () => {
  const { ana, bia, oid } = await team();
  void oid;
  for (let n = 0; n < 25; n++) assert.equal((await ana.call("POST", "/deadlines", FINAL({ scope: "office", title: `Prazo ${n}`, responsibleId: bia.user.id }))).status, 201);
  const list = await bia.call("GET", "/notifications?scope=office&perPage=20&page=1");
  assert.equal(list.body.items.length, 20);
  assert.equal(list.body.total, 25);
  assert.equal(list.body.unread, 25);
  assert.match(list.body.retentionPolicy, /retenção/);
  assert.equal((await bia.call("GET", "/notifications/unread-count?scope=office")).body.unread, 25);
  assert.equal((await bia.call("POST", `/notifications/${list.body.items[0].id}/read`, {})).status, 200);
  assert.equal((await bia.call("GET", "/notifications/unread-count?scope=office")).body.unread, 24);
  assert.equal((await bia.call("POST", "/notifications/read-all?scope=personal", {})).body.marked, 0);   // outro ambiente intocado
  assert.equal((await bia.call("GET", "/notifications/unread-count?scope=office")).body.unread, 24);
  assert.equal((await bia.call("POST", "/notifications/read-all?scope=office", {})).body.marked, 24);    // inclui a 2ª página
  assert.equal((await bia.call("GET", "/notifications/unread-count?scope=office")).body.unread, 0);
  assert.equal((await bia.call("POST", "/notifications/read-all", {})).status, 422);                    // scope obrigatório no BFF
  assert.equal((await bia.call("GET", "/notifications?scope=office&unreadOnly=yes")).status, 422);
});

test("real 6.4: notificação oculta ao perder acesso e visível ao recuperá-lo", async () => {
  const { ana, bia, caio } = await team();
  const d = (await ana.call("POST", "/deadlines", FINAL({ scope: "office", responsibleId: bia.user.id }))).body;
  assert.equal((await bia.call("GET", "/notifications/unread-count?scope=office")).body.unread, 1);
  const moved = (await ana.call("PATCH", `/deadlines/${d.id}`, { version: d.version, responsibleId: caio.user.id })).body;
  assert.equal((await bia.call("GET", "/notifications?scope=office")).body.total, 0);
  assert.equal((await bia.call("GET", "/notifications/unread-count?scope=office")).body.unread, 0);
  await ana.call("PATCH", `/deadlines/${d.id}`, { version: moved.version, responsibleId: bia.user.id });
  const back = await bia.call("GET", "/notifications?scope=office");
  assert.ok(back.body.total >= 1);
  assert.ok(back.body.items.some((n) => n.resourceId === d.id));
});
