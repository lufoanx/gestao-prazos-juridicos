// Doc 28 — rotas de arquivo do BFF (PDF da intimação) com DUBLÊ do backend (unitários).
// A integração real (FastAPI + PostgreSQL + Azurite) fica em tests/integration/intimation-files-backend.test.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import { loadBffConfig } from "../src/server/bff/config.mjs";
import { createMemorySessionStore } from "../src/server/bff/session-store.mjs";
import { createBff } from "../src/server/bff/manager.mjs";
import { createFakeBackend } from "./helpers/fake-backend.mjs";
import { pdfOfSize, syntheticPdf } from "./helpers/pdf.mjs";

const ORIGIN = "http://localhost:3000";
const ENV = { PRAZOAI_APP_ENV: "test", PRAZOAI_APP_ORIGIN: ORIGIN, PRAZOAI_COOKIE_INSECURE_LOCAL: "true" };
const MAX = 10 * 1024 * 1024;
const ID = "abc123";
const DISPOSITION = `attachment; filename="intima__o.pdf"; filename*=UTF-8''intima%C3%A7%C3%A3o.pdf`;

function setup({ download } = {}) {
  const backend = createFakeBackend();
  const fileCalls = [];
  const fetchImpl = async (url, init) => {
    const path = new URL(url).pathname.replace("/api/v1", "");
    if (path === `/intimations/${ID}/file`) {
      const headers = Object.fromEntries(Object.entries(init.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
      fileCalls.push({ method: init.method, headers, body: init.body ? Buffer.from(init.body) : null });
      if (init.method === "PUT") {
        return new Response(JSON.stringify({ id: ID, file: { storage: "stored", sizeBytes: init.body.byteLength } }),
          { status: 200, headers: { "content-type": "application/json" } });
      }
      return download ? download() : new Response(syntheticPdf(), { status: 200, headers: {
        "content-type": "application/pdf", "content-length": String(syntheticPdf().length), "content-disposition": DISPOSITION } });
    }
    return backend.fetch(url, init);
  };
  const config = loadBffConfig(ENV);
  const store = createMemorySessionStore(config.session);
  const bff = createBff({ config, store, fetchImpl, logger: { info() {} } });
  return { bff, backend, fileCalls, store };
}

async function login(env) {
  const r = await env.bff.login(new Request(`${ORIGIN}/bff/auth/login`, { method: "POST",
    headers: { "x-prazoai-csrf": "1", origin: ORIGIN, "content-type": "application/json" },
    body: JSON.stringify({ email: "ana@exemplo.com", password: "Senha-123" }) }));
  return r.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
}

function put(cookie, body, { origin = ORIGIN, csrf = true, type = "application/pdf", name = "intima%C3%A7%C3%A3o.pdf", length } = {}) {
  const h = new Headers();
  if (csrf) h.set("x-prazoai-csrf", "1");
  if (origin) h.set("origin", origin);
  if (cookie) h.set("cookie", cookie);
  if (type) h.set("content-type", type);
  if (name !== null) h.set("x-prazoai-file-name", name);
  if (length !== undefined) h.set("content-length", String(length));
  return new Request(`${ORIGIN}/bff/files/intimations/${ID}`, { method: "PUT", headers: h, body, duplex: "half" });
}
function get(cookie, { csrf = true } = {}) {
  const h = new Headers();
  if (csrf) h.set("x-prazoai-csrf", "1");
  if (cookie) h.set("cookie", cookie);
  return new Request(`${ORIGIN}/bff/files/intimations/${ID}`, { method: "GET", headers: h });
}
function streamOf(buf, chunk = 1 << 20) {
  let i = 0;
  return new ReadableStream({ pull(c) { if (i >= buf.length) { c.close(); return; } c.enqueue(buf.subarray(i, i + chunk)); i += chunk; } });
}

test("upload: Origin/CSRF, tipo e sessão verificados ANTES de ler o corpo; nada chega ao backend", async () => {
  const env = setup();
  const cookie = await login(env);
  const pdf = syntheticPdf();
  assert.equal((await env.bff.intimationFileUpload(put(cookie, pdf, { origin: "https://atacante.exemplo" }), ID)).status, 403);
  assert.equal((await env.bff.intimationFileUpload(put(cookie, pdf, { csrf: false }), ID)).status, 403);
  assert.equal((await env.bff.intimationFileUpload(put(cookie, pdf, { type: "image/png" }), ID)).status, 415);
  assert.equal((await env.bff.intimationFileUpload(put(cookie, pdf, { name: "a/b\\c" }), ID)).status, 422);
  assert.equal((await env.bff.intimationFileUpload(put(null, pdf), ID)).status, 401);
  assert.equal((await env.bff.intimationFileUpload(put(cookie, pdf), "../x")).status, 404);
  assert.equal(env.fileCalls.length, 0);
});

test("upload: limite de 10 MiB SÓ nesta rota, aplicado pelo cabeçalho e durante a leitura", async () => {
  const env = setup();
  const cookie = await login(env);
  const big = pdfOfSize(MAX + 1);
  let r = await env.bff.intimationFileUpload(put(cookie, big, { length: big.length }), ID);
  assert.equal(r.status, 413);
  r = await env.bff.intimationFileUpload(put(cookie, streamOf(big)), ID);      // sem Content-Length
  assert.equal(r.status, 413);
  assert.equal(env.fileCalls.length, 0);
  const exact = pdfOfSize(MAX);
  r = await env.bff.intimationFileUpload(put(cookie, streamOf(exact)), ID);
  assert.equal(r.status, 200);
  assert.equal(env.fileCalls[0].body.length, MAX);
  // as demais rotas continuam com o limite JSON de 64 KiB
  const proxy = await env.bff.proxy(new Request(`${ORIGIN}/bff/api/intimations`, { method: "POST",
    headers: { "x-prazoai-csrf": "1", origin: ORIGIN, cookie, "content-type": "application/json" },
    body: JSON.stringify({ pad: "x".repeat(70 * 1024) }) }), "/intimations");
  assert.equal(proxy.status, 413);
});

test("upload: bytes repassados intactos, com o token do SERVIDOR; nenhum token na resposta", async () => {
  const env = setup();
  const cookie = await login(env);
  const pdf = syntheticPdf({ payload: "% unico" });
  const r = await env.bff.intimationFileUpload(put(cookie, pdf), ID);
  assert.equal(r.status, 200);
  const call = env.fileCalls[0];
  assert.ok(call.body.equals(pdf));
  assert.equal(call.headers["content-type"], "application/pdf");
  assert.equal(call.headers["x-prazoai-file-name"], "intima%C3%A7%C3%A3o.pdf");
  assert.match(call.headers.authorization, /^Bearer a\d+-x{24}$/);
  assert.equal(call.headers.cookie, undefined);
  const text = await r.text();
  assert.equal(/a\d+-x{24}|r\d+-x{24}/.test(text), false);
});

test("download: exige o cabeçalho próprio; repassa só o PDF com anexo, nosniff e no-store", async () => {
  const env = setup();
  const cookie = await login(env);
  assert.equal((await env.bff.intimationFileDownload(get(cookie, { csrf: false }), ID)).status, 403);   // link simples não baixa
  assert.equal((await env.bff.intimationFileDownload(get(null), ID)).status, 401);
  const r = await env.bff.intimationFileDownload(get(cookie), ID);
  assert.equal(r.status, 200);
  assert.ok(Buffer.from(await r.arrayBuffer()).equals(syntheticPdf()));
  assert.equal(r.headers.get("content-type"), "application/pdf");
  assert.equal(r.headers.get("content-disposition"), DISPOSITION);
  assert.equal(r.headers.get("x-content-type-options"), "nosniff");
  assert.equal(r.headers.get("cache-control"), "no-store, private");
  assert.equal(r.headers.get("set-cookie"), null);
});

test("download: resposta do backend fora do contrato não é repassada", async () => {
  const pdf = syntheticPdf();
  const cases = [
    () => new Response("<html>", { status: 200, headers: { "content-type": "text/html", "content-length": "6", "content-disposition": DISPOSITION } }),
    () => new Response(pdf, { status: 200, headers: { "content-type": "application/pdf", "content-length": String(pdf.length), "content-disposition": "inline" } }),
    () => new Response(pdf, { status: 200, headers: { "content-type": "application/pdf", "content-disposition": DISPOSITION } }),  // sem tamanho
  ];
  for (const download of cases) {
    const env = setup({ download });
    const cookie = await login(env);
    const r = await env.bff.intimationFileDownload(get(cookie), ID);
    assert.ok([502, 503].includes(r.status), String(r.status));
  }
  // corpo maior que o declarado: o fluxo é interrompido (nunca entrega mais que o declarado)
  const env = setup({ download: () => new Response(pdf, { status: 200, headers: {
    "content-type": "application/pdf", "content-length": String(pdf.length - 10), "content-disposition": DISPOSITION } }) });
  const cookie = await login(env);
  const r = await env.bff.intimationFileDownload(get(cookie), ID);
  await assert.rejects(r.arrayBuffer());
  // erro JSON do backend (ex.: 404) passa como erro, sem corpo de arquivo
  const env404 = setup({ download: () => new Response(JSON.stringify({ error: { code: "not_found", message: "x" } }),
    { status: 404, headers: { "content-type": "application/json" } }) });
  const c404 = await login(env404);
  const r404 = await env404.bff.intimationFileDownload(get(c404), ID);
  assert.equal(r404.status, 404);
  assert.equal((await r404.json()).error.code, "not_found");
});
