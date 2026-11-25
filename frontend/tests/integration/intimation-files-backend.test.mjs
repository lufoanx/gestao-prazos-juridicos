// Doc 28 — INTEGRAÇÃO REAL do PDF da intimação: BFF → FastAPI (STORAGE=postgres) → Azure Blob (Azurite).
// Requer, só recursos LOCAIS e descartáveis:
//   PRAZOAI_TEST_FILES_DATABASE_URL       postgresql+psycopg://... de um banco *_test (migrado aqui)
//   PRAZOAI_TEST_AZURITE_CONNECTION_STRING conexão do Azurite local (devstoreaccount1, 127.0.0.1)
// Sem elas, os testes são PULADOS — ou FALHAM com PRAZOAI_REQUIRE_FILES_TESTS=1 (CI). PDFs sintéticos.
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { loadBffConfig } from "../../src/server/bff/config.mjs";
import { createMemorySessionStore } from "../../src/server/bff/session-store.mjs";
import { createBff } from "../../src/server/bff/manager.mjs";
import { pdfOfSize, syntheticPdf } from "../helpers/pdf.mjs";

const BACKEND_DIR = fileURLToPath(new URL("../../../backend", import.meta.url));
const PYTHON = process.env.PRAZOAI_TEST_PYTHON || "python3";
const DB = process.env.PRAZOAI_TEST_FILES_DATABASE_URL || "";
const AZ = process.env.PRAZOAI_TEST_AZURITE_CONNECTION_STRING || "";
if ((!DB || !AZ) && process.env.PRAZOAI_REQUIRE_FILES_TESTS === "1") {
  throw new Error("PRAZOAI_REQUIRE_FILES_TESTS=1 exige PRAZOAI_TEST_FILES_DATABASE_URL e PRAZOAI_TEST_AZURITE_CONNECTION_STRING");
}
if (DB && !/_test$/.test(new URL(DB.replace("+psycopg", "")).pathname)) throw new Error("banco de teste deve terminar em _test");
if (AZ && !(AZ.includes("devstoreaccount1") && AZ.includes("127.0.0.1"))) throw new Error("somente Azurite local");
const SKIP = DB && AZ ? false : "PRAZOAI_TEST_FILES_DATABASE_URL/PRAZOAI_TEST_AZURITE_CONNECTION_STRING não definidas";

const ORIGIN = "http://localhost:3000";
const PORT = 17900 + Math.floor(Math.random() * 90);         // faixa própria
const BASE = `http://127.0.0.1:${PORT}`;
const PROXY_SECRET = randomBytes(32).toString("hex");
const JWT = randomBytes(32).toString("hex");                // estável entre reinícios do backend
const CONTAINER = `t${randomBytes(10).toString("hex")}`;
const PASSWORD = "Senha-de-teste-123";
const MAX = 10 * 1024 * 1024;
const backendEnv = { ...process.env, ENVIRONMENT: "test", STORAGE: "postgres", DATABASE_URL: DB, AUTH_JWT_SECRET: JWT,
  TRUSTED_PROXY_SECRET: PROXY_SECRET, LOG_LEVEL: "WARNING", FILE_STORAGE: "azure_blob",
  AZURE_STORAGE_CONNECTION_STRING: AZ, AZURE_STORAGE_CONTAINER: CONTAINER, AUTH_REGISTER_MAX_REQUESTS: "100" };
let proc;

function run(args) {
  return new Promise((resolve) => {
    const p = spawn(PYTHON, args, { cwd: BACKEND_DIR, env: backendEnv, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    p.stdout.on("data", (d) => { out += d; });
    p.stderr.on("data", (d) => { out += d; });
    p.on("close", (code) => resolve({ code, out }));
  });
}
async function startBackend() {
  proc = spawn(PYTHON, ["-m", "uvicorn", "app.main:app", "--port", String(PORT), "--host", "127.0.0.1", "--no-proxy-headers"],
    { cwd: BACKEND_DIR, env: backendEnv, stdio: ["ignore", "ignore", "ignore"] });
  for (let i = 0; i < 150; i++) {
    try { if ((await fetch(`${BASE}/api/v1/health/ready`)).ok) return; } catch { /* subindo */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("backend não ficou pronto");
}
async function stopBackend() {
  if (!proc) return;
  const exited = new Promise((r) => proc.once("exit", r));
  proc.kill("SIGTERM");
  await exited;
  proc = null;
}

before(async () => {
  if (SKIP) return;
  const mig = await run(["-m", "alembic", "upgrade", "head"]);
  assert.equal(mig.code, 0, mig.out.slice(-400));
  const mk = await run(["-m", "app.files", "create-container"]);         // comando explícito: container PRIVADO
  assert.equal(mk.code, 0, mk.out.slice(-400));
  await startBackend();
});
after(async () => { await stopBackend(); });

const config = loadBffConfig({ PRAZOAI_APP_ENV: "test", PRAZOAI_APP_ORIGIN: ORIGIN, PRAZOAI_COOKIE_INSECURE_LOCAL: "true",
  PRAZOAI_BACKEND_URL: BASE, PRAZOAI_PROXY_SECRET: PROXY_SECRET, PRAZOAI_TRUSTED_CLIENT_IP_HEADER: "x-test-client-ip" });
const bff = createBff({ config, store: createMemorySessionStore(config.session), logger: { info() {}, error() {} } });

let ipSeq = 1;
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
  const headers = (extra = {}) => {
    const h = new Headers({ "x-prazoai-csrf": "1", origin: ORIGIN, "x-test-client-ip": ip, ...extra });
    if (jar.size) h.set("cookie", [...jar].map(([n, v]) => `${n}=${v}`).join("; "));
    return h;
  };
  const p = {
    async call(method, path, body) {
      const h = headers(body !== undefined ? { "content-type": "application/json" } : {});
      const r = apply(await bff.proxy(new Request(`${ORIGIN}/bff/api${path}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) }), path.split("?")[0]));
      const t = await r.text();
      return { status: r.status, body: t ? JSON.parse(t) : null };
    },
    async upload(id, bytes, name = "intimação sintética.pdf") {
      const r = apply(await bff.intimationFileUpload(new Request(`${ORIGIN}/bff/files/intimations/${id}`, { method: "PUT",
        headers: headers({ "content-type": "application/pdf", "x-prazoai-file-name": encodeURIComponent(name) }), body: bytes, duplex: "half" }), id));
      const t = await r.text();
      return { status: r.status, body: t ? JSON.parse(t) : null };
    },
    async download(id) {
      const r = apply(await bff.intimationFileDownload(new Request(`${ORIGIN}/bff/files/intimations/${id}`, { headers: headers() }), id));
      return { status: r.status, headers: r.headers, bytes: Buffer.from(await r.arrayBuffer()) };
    },
    async signup(name) {
      const email = `pdf${randomBytes(4).toString("hex")}@exemplo.com`;
      const h = headers({ "content-type": "application/json" });
      assert.equal((await bff.register(new Request(`${ORIGIN}/bff/auth/register`, { method: "POST", headers: h, body: JSON.stringify({ name, email, password: PASSWORD }) }))).status, 201);
      const r = apply(await bff.login(new Request(`${ORIGIN}/bff/auth/login`, { method: "POST", headers: headers({ "content-type": "application/json" }), body: JSON.stringify({ email, password: PASSWORD }) })));
      assert.equal(r.status, 200);
      p.user = (await r.json()).user;
      return p;
    },
    async logout() { apply(await bff.logout(new Request(`${ORIGIN}/bff/auth/logout`, { method: "POST", headers: headers() }))); },
  };
  return p;
}
const META = (over = {}) => ({ scope: "personal", fileName: "intimacao.pdf", sizeBytes: 1024, contentType: "application/pdf", receivedAt: "2026-11-20", ...over });
const FINAL = { title: "Contestação manual", caseNumber: "0001234-56.2026", court: "TJSC", practiceArea: "Cível", priority: "normal",
  startDate: "2026-11-20", dueDate: "2026-12-04", countingMode: "business", duration: 10 };

test("real: upload → download idêntico; outra conta e sem sessão recusados; inválidos recusados", { skip: SKIP }, async () => {
  const ana = await browser().signup("Ana");
  const bia = await browser().signup("Bia");
  const i = (await ana.call("POST", "/intimations", META())).body;
  const pdf = syntheticPdf({ payload: `% ${randomBytes(8).toString("hex")}` });
  for (const [bytes, status] of [[Buffer.from("não sou PDF"), 415], [syntheticPdf({ encrypted: true }), 422], [pdf.subarray(0, pdf.length - 30), 422]]) {
    assert.equal((await ana.upload(i.id, bytes)).status, status);
  }
  assert.equal((await ana.upload(i.id, pdfOfSize(MAX + 1))).status, 413);
  assert.equal((await ana.call("GET", `/intimations/${i.id}`)).body.file.storage, "not_stored");
  const up = await ana.upload(i.id, pdf);
  assert.equal(up.status, 200);
  assert.equal(up.body.file.storage, "stored");
  assert.equal(up.body.file.name, "intimação sintética.pdf");
  const d = await ana.download(i.id);
  assert.equal(d.status, 200);
  assert.ok(d.bytes.equals(pdf), "bytes idênticos");
  assert.equal(d.headers.get("x-content-type-options"), "nosniff");
  assert.match(d.headers.get("content-disposition"), /^attachment;/);
  assert.equal((await bia.download(i.id)).status, 404);                  // conhece o id, não acessa
  assert.equal((await bia.upload(i.id, pdf)).status, 404);
  const anon = browser();
  assert.equal((await anon.download(i.id)).status, 401);
  assert.equal((await ana.upload(i.id, syntheticPdf({ payload: "%2" }))).status, 409);   // 1 PDF por intimação
});

test("real: PDF recuperado depois de reiniciar o backend (PostgreSQL + Blob persistentes)", { skip: SKIP }, async () => {
  const ana = await browser().signup("Ana Reinício");
  const i = (await ana.call("POST", "/intimations", META())).body;
  const pdf = syntheticPdf({ payload: `% reinicio ${randomBytes(8).toString("hex")}` });
  assert.equal((await ana.upload(i.id, pdf)).status, 200);
  await stopBackend();
  await startBackend();                                                  // processo novo, clientes novos
  const d = await ana.download(i.id);
  assert.equal(d.status, 200);
  assert.ok(d.bytes.equals(pdf));
});

test("real: upload → preenchimento manual → confirmação → prazo vinculado → download; sem duplicar", { skip: SKIP }, async () => {
  const ana = await browser().signup("Ana Fluxo");
  const i = (await ana.call("POST", "/intimations", META())).body;
  const pdf = syntheticPdf({ payload: "% fluxo" });
  const v = (await ana.upload(i.id, pdf)).body.version;
  const draft = await ana.call("PATCH", `/intimations/${i.id}`, { version: v, title: "Contestação manual" });
  assert.equal(draft.status, 200);
  const first = await ana.call("POST", `/intimations/${i.id}/confirm`, { version: draft.body.version, ...FINAL, responsibleId: ana.user.id });
  assert.equal(first.status, 201);
  const again = await ana.call("POST", `/intimations/${i.id}/confirm`, { version: draft.body.version, ...FINAL, responsibleId: ana.user.id });
  assert.equal(again.status, 200);
  assert.equal(again.body.created, false);
  const deadlineId = first.body.deadline.id;
  assert.equal(again.body.deadline.id, deadlineId);
  assert.equal((await ana.call("GET", "/deadlines?scope=personal")).body.total, 1);
  const linked = await ana.call("GET", `/deadlines/${deadlineId}/intimation`);
  assert.equal(linked.status, 200);
  assert.equal(linked.body.id, i.id);
  assert.ok((await ana.download(linked.body.id)).bytes.equals(pdf));
});

test("real: escritório — membro com visibilidade restrita não acessa o PDF de outra pessoa", { skip: SKIP }, async () => {
  const adm = await browser().signup("Adm");
  const mem = await browser().signup("Mem");
  const oid = (await adm.call("POST", "/offices", { name: "Escritório PDF" })).body.office.id;
  const inv = await adm.call("POST", `/offices/${oid}/invitations`, {});
  assert.equal((await mem.call("POST", "/invitations/accept", { token: inv.body.token })).status, 200);
  assert.equal((await adm.call("PATCH", `/offices/${oid}/members/${mem.user.id}`,
    { permissions: ["deadline.read", "deadline.create"], visibility: "assigned" })).status, 200);
  const i = (await adm.call("POST", "/intimations", META({ scope: "office" }))).body;
  assert.equal((await adm.upload(i.id, syntheticPdf())).status, 200);
  assert.equal((await mem.download(i.id)).status, 404);
  assert.equal((await mem.upload(i.id, syntheticPdf())).status, 404);
  // com responsável sugerido = membro, a leitura passa a valer
  const j = (await adm.call("POST", "/intimations", META({ scope: "office", suggestedResponsibleId: mem.user.id }))).body;
  assert.equal((await adm.upload(j.id, syntheticPdf({ payload: "%j" }))).status, 200);
  assert.equal((await mem.download(j.id)).status, 200);
});
