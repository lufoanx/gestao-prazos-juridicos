// Etapa 6.3 — BFF (query strings controladas, allowlist de prazos) e bibliotecas de cliente, com DUBLÊS.
import test from "node:test";
import assert from "node:assert/strict";
import { buildQuery, findRoute, matchAllowlist } from "../src/server/bff/allowlist.mjs";
import { loadBffConfig } from "../src/server/bff/config.mjs";
import { createMemorySessionStore } from "../src/server/bff/session-store.mjs";
import { createBff } from "../src/server/bff/manager.mjs";
import { createApiClient } from "../src/lib/integration/api-client.mjs";
import { canonicalQuery, createDeadlinesClient, fetchWholeMonth, LIST_PARAMS } from "../src/lib/integration/deadlines-client.mjs";
import { addMonths, formatCivilDate, isCivilDate, monthGrid } from "../src/lib/integration/civil-date.mjs";
import { canTransferToOffice, deadlineCaps, displayName, selectableResponsibles } from "../src/lib/integration/deadline-caps.mjs";
import { describeEvent } from "../src/lib/integration/history-format.mjs";
import { cacheKey } from "../src/lib/integration/query-cache.mjs";
import { createFakeBackend, tok } from "./helpers/fake-backend.mjs";

const ORIGIN = "http://localhost:3000";
const ID = "d".repeat(32);
const qs = (s) => new URLSearchParams(s);
const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

// ---------------------------------------------------------------- allowlist e query
test("allowlist 6.3: rotas de prazos/calendário liberadas; intimações/notificações fora", () => {
  for (const [m, p] of [["GET", "/deadlines"], ["POST", "/deadlines"], ["GET", `/deadlines/${ID}`], ["PATCH", `/deadlines/${ID}`],
    ["POST", `/deadlines/${ID}/status`], ["POST", `/deadlines/${ID}/transfer`], ["GET", `/deadlines/${ID}/comments`],
    ["POST", `/deadlines/${ID}/comments`], ["GET", `/deadlines/${ID}/history`], ["GET", "/calendar"]]) {
    assert.equal(matchAllowlist(m, p), "ok", `${m} ${p}`);
  }
  assert.equal(matchAllowlist("DELETE", `/deadlines/${ID}`), "method_not_allowed");
  assert.equal(matchAllowlist("POST", `/deadlines/${ID}/history`), "method_not_allowed");
  for (const p of ["/intimations", "/notifications", `/deadlines/${ID}/attachments`]) assert.equal(matchAllowlist("GET", p), "not_found");
});

test("query: canônica, validada por rota; desconhecido, repetido, inválido e obrigatório ausente recusados", () => {
  const list = findRoute("GET", "/deadlines");
  assert.deepEqual(buildQuery(list, qs("page=2&scope=office&dir=desc&sort=title&q=réplica trabalhista")),
    { ok: true, query: "scope=office&q=r%C3%A9plica+trabalhista&sort=title&dir=desc&page=2" });
  for (const bad of ["scope=office&host=evil.example", "scope=office&scope=personal", "scope=global", "scope=office&perPage=101",
    "scope=office&page=0", "scope=office&dueFrom=20261120", "scope=office&status=deleted", "q=x", "scope=office&responsibleId=a/b",
    "scope=office&q=" + "x".repeat(101), "scope=office&q=%00"]) {
    assert.equal(buildQuery(list, qs(bad)).ok, false, bad);
  }
  const cal = findRoute("GET", "/calendar");
  assert.equal(buildQuery(cal, qs("scope=office&year=2026&month=11&perPage=500")).ok, true);
  assert.equal(buildQuery(cal, qs("scope=office&year=2026&month=11&perPage=501")).ok, false);
  assert.equal(buildQuery(cal, qs("scope=office&year=2026")).ok, false);
  assert.equal(buildQuery(cal, qs("scope=office&year=1999&month=1")).ok, false);
  const comments = findRoute("GET", `/deadlines/${ID}/comments`);
  assert.deepEqual(buildQuery(comments, qs("perPage=50&page=3")), { ok: true, query: "page=3&perPage=50" });
  assert.equal(buildQuery(comments, qs("page=1&scope=office")).ok, false);
  const legacy = findRoute("GET", "/memberships/me");                         // rotas antigas: query ignorada
  assert.deepEqual(buildQuery(legacy, qs("x=1&x=2")), { ok: true, query: "" });
});

function bffWith(handler) {
  const config = loadBffConfig({ PRAZOAI_APP_ENV: "test", PRAZOAI_APP_ORIGIN: ORIGIN, PRAZOAI_COOKIE_INSECURE_LOCAL: "true" });
  const store = createMemorySessionStore(config.session);
  const backend = createFakeBackend();
  const calls = [];
  const fetchImpl = async (url, init) => {
    const u = new URL(url);
    if (u.pathname.startsWith("/api/v1/auth/")) return backend.fetch(url, init);
    calls.push({ url: String(url), init });
    return handler(u, init);
  };
  return { bff: createBff({ config, store, fetchImpl, logger: { info() {} } }), calls };
}
async function loggedIn(env) {
  const h = new Headers({ "x-prazoai-csrf": "1", origin: ORIGIN, "content-type": "application/json" });
  const r = await env.bff.login(new Request(`${ORIGIN}/bff/auth/login`, { method: "POST", headers: h, body: JSON.stringify({ email: "a@b.c", password: "x" }) }));
  return r.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
}
const get = (cookie, url) => new Request(url, { method: "GET", headers: new Headers({ "x-prazoai-csrf": "1", cookie }) });

test("proxy: query remontada pelo BFF; destino e caminho fixos; valores com '/' ficam codificados", async () => {
  const env = bffWith(() => json(200, { items: [], page: 1, perPage: 20, total: 0, pageCount: 1, referenceDate: "2026-11-09" }));
  const cookie = await loggedIn(env);
  const r = await env.bff.proxy(get(cookie, `${ORIGIN}/bff/api/deadlines?q=%2F..%2Fadmin%3Fx%3D1&scope=office&page=1`), "/deadlines");
  assert.equal(r.status, 200);
  const sent = new URL(env.calls[0].url);
  assert.equal(sent.origin, "http://127.0.0.1:8000");
  assert.equal(sent.pathname, "/api/v1/deadlines");
  assert.equal(sent.searchParams.get("q"), "/../admin?x=1");
  assert.equal(sent.search, "?scope=office&q=%2F..%2Fadmin%3Fx%3D1&page=1");
  const bad = await env.bff.proxy(get(cookie, `${ORIGIN}/bff/api/deadlines?scope=office&url=http://evil`), "/deadlines");
  assert.equal(bad.status, 422);
  assert.equal(env.calls.length, 1);                                            // recusado sem chamar o backend
});

test("proxy: 409 preserva X-Current-Version; 429 preserva Retry-After", async () => {
  let n = 0;
  const env = bffWith(() => (n++ === 0
    ? json(409, { error: { code: "version_conflict", message: "x" } }, { "x-current-version": "4" })
    : json(429, { error: { code: "rate_limited", message: "x" } }, { "retry-after": "30" })));
  const cookie = await loggedIn(env);
  const patch = new Request(`${ORIGIN}/bff/api/deadlines/${ID}`, { method: "PATCH",
    headers: new Headers({ "x-prazoai-csrf": "1", origin: ORIGIN, cookie, "content-type": "application/json" }), body: JSON.stringify({ version: 3, title: "Novo" }) });
  const r = await env.bff.proxy(patch, `/deadlines/${ID}`);
  assert.equal(r.status, 409);
  assert.equal(r.headers.get("x-current-version"), "4");
  const r2 = await env.bff.proxy(get(cookie, `${ORIGIN}/bff/api/deadlines?scope=personal`), "/deadlines");
  assert.equal(r2.headers.get("retry-after"), "30");
});

// ---------------------------------------------------------------- cliente
test("cliente: query canônica (chave de cache estável) e consentimentos explícitos", async () => {
  assert.equal(canonicalQuery({ page: 2, scope: "office", q: "", status: "open", dir: undefined }, LIST_PARAMS), "scope=office&status=open&page=2");
  const seen = [];
  const api = createApiClient({ fetchImpl: async (url, init) => { seen.push({ url, init }); return json(200, {}); } });
  const c = createDeadlinesClient(api);
  await c.transfer(ID, 2, "o".repeat(10));
  await c.transfer(ID, 2, "o".repeat(10), { shareLinkedIntimation: true });
  await c.list({ scope: "office", sort: "title", page: 3 });
  assert.deepEqual(JSON.parse(seen[0].init.body), { version: 2, officeId: "o".repeat(10), confirmSharing: true });   // nunca implícito
  assert.deepEqual(JSON.parse(seen[1].init.body), { version: 2, officeId: "o".repeat(10), confirmSharing: true, shareLinkedIntimation: true });
  assert.equal(seen[2].url, "/bff/api/deadlines?scope=office&sort=title&page=3");
  assert.throws(() => c.get("../x"));
  const k1 = cacheKey({ userId: "u", officeId: "o", scope: "office", revision: 1 }, "deadlines?scope=office&page=1");
  const k2 = cacheKey({ userId: "u", officeId: "o", scope: "office", revision: 1 }, "deadlines?scope=office&page=2");
  assert.notEqual(k1, k2);
});

test("calendário: busca TODAS as páginas do mês; total e contagens vêm do servidor", async () => {
  const pages = [1, 2, 3].map((p) => ({ year: 2026, month: 11, referenceDate: "2026-11-09", timezone: "America/Sao_Paulo",
    items: [{ id: `p${p}` }], countsByDay: { "2026-11-20": 3 }, page: p, perPage: 1, total: 3, pageCount: 3,
    hasNextPage: p < 3, nextPage: p < 3 ? p + 1 : null }));
  const asked = [];
  const client = { calendar: async (params) => { asked.push(params.page); return pages[params.page - 1]; } };
  const progress = [];
  const r = await fetchWholeMonth(client, { scope: "office", year: 2026, month: 11 }, { onPage: (p, of) => progress.push(`${p}/${of}`) });
  assert.deepEqual(asked, [1, 2, 3]);
  assert.deepEqual(r.items.map((i) => i.id), ["p1", "p2", "p3"]);
  assert.equal(r.complete, true);
  assert.deepEqual(progress, ["1/3", "2/3", "3/3"]);
  const partial = await fetchWholeMonth(client, { scope: "office", year: 2026, month: 11 }, { maxPages: 2 });
  assert.equal(partial.complete, false);
  assert.equal(partial.total, 3);                                                 // total do servidor, não da página
});

// ---------------------------------------------------------------- datas civis
test("datas civis: sem mudança de dia em fusos distintos", () => {
  const original = process.env.TZ;
  try {
    for (const tz of ["Pacific/Kiritimati", "America/Los_Angeles", "Pacific/Pago_Pago", "UTC"]) {
      process.env.TZ = tz;
      assert.equal(formatCivilDate("2026-11-20"), "20/11/2026", tz);
      assert.equal(monthGrid(2026, 11)[0][0], "2026-11-01", tz);                  // 01/11/2026 é domingo
      assert.equal(monthGrid(2028, 2).flat().filter(Boolean).at(-1), "2028-02-29", tz);
    }
  } finally {
    if (original === undefined) delete process.env.TZ; else process.env.TZ = original;
  }
  assert.equal(isCivilDate("2026-02-30"), false);
  assert.equal(isCivilDate("2026-02-28"), true);
  assert.deepEqual(addMonths(2026, 12, 1), { year: 2027, month: 1 });
  assert.deepEqual(addMonths(2026, 1, -1), { year: 2025, month: 12 });
  assert.equal(formatCivilDate("20/11/2026"), "—");
});

// ---------------------------------------------------------------- capacidades e nomes
const m = (perms, visibility = "assigned") => ({ officeId: "o", roleLabel: "Sócio", practiceAreas: [], permissions: perms, visibility, joinedAt: "" });

test("capacidades de prazos espelham as políticas; cargo/gestão não concedem acesso", () => {
  assert.equal(deadlineCaps("personal", null).canEdit, true);
  assert.equal(deadlineCaps("office", m(["team.manage", "office.manage"], "all")).canRead, false);
  const reader = deadlineCaps("office", m(["deadline.read"]));
  assert.deepEqual([reader.canRead, reader.canCreate, reader.canEdit, reader.canComplete, reader.canComment], [true, false, false, false, false]);
  assert.equal(deadlineCaps("office", m(["deadline.create"])).canCreate, false);    // sem read não cria
  assert.equal(canTransferToOffice(m(["deadline.transfer"])), false);
  assert.equal(canTransferToOffice(m(["deadline.transfer", "deadline.read"])), true);
  const me = { id: "u1", name: "Ana" };
  const members = [{ userId: "u1", name: "Ana" }, { userId: "u2", name: "Bia" }];
  assert.deepEqual(selectableResponsibles("office", m(["deadline.read"], "assigned"), members, me), [{ userId: "u1", name: "Ana" }]);
  assert.deepEqual(selectableResponsibles("office", m(["deadline.read"], "all"), members, me), members);
  assert.deepEqual(selectableResponsibles("personal", m([], "all"), members, me), [{ userId: "u1", name: "Ana" }]);
  const names = new Map([["u2", "Bia"]]);
  assert.equal(displayName("u2", names, me), "Bia");
  assert.equal(displayName("u1", names, me), "Ana (você)");
  assert.equal(displayName("x9", names, me), "Pessoa fora do escritório");       // nunca o id
});

test("histórico: referências protegidas não são reveladas; pessoas viram nomes", () => {
  const nameOf = (id) => ({ u1: "Ana", u2: "Bia" }[id] ?? "Pessoa fora do escritório");
  const created = describeEvent({ id: "e", actorId: "u1", action: "created", at: "", details: { responsibleId: "u2", source: { intimationId: null, intimationIdHidden: true } } }, nameOf);
  assert.equal(created, "Prazo criado (responsável: Bia) a partir de uma intimação.");
  const moved = describeEvent({ id: "e", actorId: "u1", action: "transferred", at: "", details: { fromScope: "personal", toOfficeId: "o1", linkedIntimationId: null, linkedIntimationIdHidden: true } }, nameOf);
  assert.ok(!moved.includes("o1"));
  assert.equal(describeEvent({ id: "e", actorId: "u1", action: "reassigned", at: "", details: { fromResponsibleId: "u1", toResponsibleId: "zz", reason: "member_removed" } }, nameOf),
    "Responsável alterado de Ana para Pessoa fora do escritório (remoção de membro).");
  assert.equal(describeEvent({ id: "e", actorId: "u1", action: "other", at: "", details: { deadlineId: null, deadlineIdHidden: true } }, nameOf),
    "Evento com vínculo a recurso protegido.");
});

test("fake do backend com tokens realistas continua disponível", () => { assert.ok(tok("a", 1).length > 16); });
