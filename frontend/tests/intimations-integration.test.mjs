// Etapa 6.4 — BFF (allowlist de intimações/notificações) e bibliotecas de cliente, com DUBLÊS.
import test from "node:test";
import assert from "node:assert/strict";
import { buildQuery, findRoute, matchAllowlist } from "../src/server/bff/allowlist.mjs";
import { createApiClient } from "../src/lib/integration/api-client.mjs";
import { createIntimationsClient, createNotificationsClient, notificationHref } from "../src/lib/integration/intimations-client.mjs";
import { canRegisterIntimation, draftChanges, intimationCaps } from "../src/lib/integration/intimation-caps.mjs";
import { describeIntimationEvent } from "../src/lib/integration/history-format.mjs";
import { createQueryCache } from "../src/lib/integration/query-cache.mjs";

const ID = "i".repeat(32);
const qs = (s) => new URLSearchParams(s);
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

test("allowlist 6.4: só as rotas usadas pelas telas; retry fora", () => {
  for (const [m, p] of [["GET", "/intimations"], ["POST", "/intimations"], ["GET", `/intimations/${ID}`], ["PATCH", `/intimations/${ID}`],
    ["POST", `/intimations/${ID}/confirm`], ["POST", `/intimations/${ID}/discard`], ["GET", `/intimations/${ID}/history`],
    ["GET", "/notifications"], ["GET", "/notifications/unread-count"], ["POST", `/notifications/${ID}/read`], ["POST", "/notifications/read-all"]]) {
    assert.equal(matchAllowlist(m, p), "ok", `${m} ${p}`);
  }
  assert.equal(matchAllowlist("POST", `/intimations/${ID}/retry`), "not_found");
  assert.equal(matchAllowlist("DELETE", `/intimations/${ID}`), "method_not_allowed");
  assert.equal(matchAllowlist("POST", "/invitations/lookup"), "not_found");
});

test("query 6.4: escopo obrigatório, enums e limites; read-all (POST) aceita só scope", () => {
  const list = findRoute("GET", "/intimations");
  assert.deepEqual(buildQuery(list, qs("perPage=20&status=reviewed&scope=office&q=contesta")),
    { ok: true, query: "scope=office&status=reviewed&q=contesta&perPage=20" });
  for (const bad of ["status=reviewed", "scope=office&status=accepted", "scope=office&perPage=101", "scope=office&scope=personal", "scope=office&x=1"]) {
    assert.equal(buildQuery(list, qs(bad)).ok, false, bad);
  }
  const notif = findRoute("GET", "/notifications");
  assert.equal(buildQuery(notif, qs("scope=office&unreadOnly=true&page=2")).ok, true);
  assert.equal(buildQuery(notif, qs("scope=office&unreadOnly=1")).ok, false);
  const readAll = findRoute("POST", "/notifications/read-all");
  assert.deepEqual(buildQuery(readAll, qs("scope=personal")), { ok: true, query: "scope=personal" });
  assert.equal(buildQuery(readAll, qs("")).ok, false);
  assert.equal(buildQuery(readAll, qs("scope=office&page=1")).ok, false);
  assert.equal(buildQuery(findRoute("GET", "/notifications/unread-count"), qs("scope=office&scope=office")).ok, false);
});

test("cliente: registro só com metadados do contrato; PATCH com null explícito; confirmação explícita", async () => {
  const seen = [];
  const api = createApiClient({ fetchImpl: async (url, init) => { seen.push({ url, init }); return json(200, {}); } });
  const c = createIntimationsClient(api);
  await c.register("office", { fileName: "a.pdf", sizeBytes: 100, contentType: "application/pdf", receivedAt: "2026-11-01", content: "JVBERi0", bytes: [1] });
  assert.deepEqual(JSON.parse(seen[0].init.body), { scope: "office", fileName: "a.pdf", sizeBytes: 100, contentType: "application/pdf", receivedAt: "2026-11-01" });
  await c.updateDraft(ID, 3, { title: "Novo", agendaTime: null });
  assert.deepEqual(JSON.parse(seen[1].init.body), { version: 3, title: "Novo", agendaTime: null });
  await c.confirm(ID, 4, { title: "T", caseNumber: "123", court: "TJ", practiceArea: "Cível", priority: "normal", startDate: "2026-11-01",
    dueDate: "2026-11-20", countingMode: "business", duration: 10 });
  assert.equal(JSON.parse(seen[2].init.body).version, 4);
  const n = createNotificationsClient(api);
  await n.readAll("office");
  await n.list({ scope: "office", unreadOnly: true, page: 2 });
  await n.unreadCount("personal");
  assert.equal(seen[3].url, "/bff/api/notifications/read-all?scope=office");
  assert.equal(seen[3].init.method, "POST");
  assert.equal(seen[4].url, "/bff/api/notifications?scope=office&unreadOnly=true&page=2&perPage=20");
  assert.equal(seen[5].url, "/bff/api/notifications/unread-count?scope=personal");
  assert.equal(notificationHref({ resourceType: "deadline", resourceId: ID }), `/app/prazos/${ID}`);
  assert.equal(notificationHref({ resourceType: "intimation", resourceId: ID }), `/app/intimacoes/${ID}`);
  assert.equal(notificationHref({ resourceType: "deadline", resourceId: "../x" }), null);
});

test("rascunho: omitido mantém, apagado vira null, número para duração, sugestão com a mesma regra", () => {
  const original = { title: "A", caseNumber: null, court: "TJ", practiceArea: null, startDate: "2026-11-01", dueDate: null,
    countingMode: null, duration: 5, priority: null, agendaTime: "09:00" };
  const form = { title: "A", caseNumber: "123", court: "", practiceArea: "", startDate: "2026-11-01", dueDate: "", countingMode: "",
    duration: "7", priority: "", agendaTime: "" };
  assert.deepEqual(draftChanges(original, form, "u1", "u1"), { caseNumber: "123", court: null, duration: 7, agendaTime: null });
  assert.deepEqual(draftChanges(original, { ...form, caseNumber: "", court: "TJ", duration: "5", agendaTime: "09:00" }, "u1", ""), { suggestedResponsibleId: null });
  assert.deepEqual(draftChanges(original, { ...form, caseNumber: "", court: "TJ", duration: "5", agendaTime: "09:00" }, null, "u2"), { suggestedResponsibleId: "u2" });
});

const m = (perms, visibility = "assigned", officeId = "o") => ({ officeId, roleLabel: "Sócio", practiceAreas: [], permissions: perms, visibility, joinedAt: "" });
const intim = (over = {}) => ({ id: "i1", scope: { kind: "office", ownerId: null, officeId: "o" }, status: "awaiting_review",
  processing: { status: "not_available", attempts: 0, failureCode: null }, createdBy: "autor", ...over });

test("capacidades de intimação: específicas, não copiadas de prazos; cargo/gestão não concedem nada", () => {
  const member = m(["deadline.read", "deadline.create"]);
  assert.deepEqual(intimationCaps(intim(), member, "outro"), { canEditDraft: true, canConfirm: true, canDiscard: false, canRetry: false });
  assert.equal(intimationCaps(intim(), member, "autor").canDiscard, true);                    // autor
  assert.equal(intimationCaps(intim(), m(["deadline.read", "deadline.create"], "all"), "x").canDiscard, true);   // all
  assert.equal(intimationCaps(intim(), m(["deadline.read", "deadline.edit", "deadline.complete"], "all"), "autor").canEditDraft, false);  // sem create
  assert.equal(intimationCaps(intim(), m(["team.manage", "office.manage"], "all"), "autor").canEditDraft, false);
  assert.equal(intimationCaps(intim(), m(["deadline.read", "deadline.create"], "all", "o2"), "autor").canEditDraft, false);  // outro escritório
  for (const status of ["reviewed", "discarded"]) {
    const c = intimationCaps(intim({ status }), m(["deadline.read", "deadline.create"], "all"), "autor");
    assert.deepEqual(c, { canEditDraft: false, canConfirm: false, canDiscard: false, canRetry: false }, status);   // terminais
  }
  assert.equal(intimationCaps(intim({ status: "failed" }), m(["deadline.read", "deadline.create"], "all"), "autor").canRetry, false);  // sem processamento real
  const personal = intim({ scope: { kind: "personal", ownerId: "u1", officeId: null } });
  assert.equal(intimationCaps(personal, null, "u1").canConfirm, true);
  assert.equal(intimationCaps(personal, m(["deadline.read", "deadline.create"], "all"), "u2").canConfirm, false);
  assert.equal(canRegisterIntimation("personal", null), true);
  assert.equal(canRegisterIntimation("office", m(["deadline.read"])), false);
  assert.equal(canRegisterIntimation("office", m(["deadline.read", "deadline.create"])), true);
});

test("histórico de intimação legível e sem identificadores protegidos", () => {
  const nameOf = (id) => ({ u1: "Ana", u2: "Bia" }[id] ?? "Pessoa fora do escritório");
  assert.equal(describeIntimationEvent({ id: "e", actorId: "u1", action: "registered", at: "", details: { fileStorage: "not_stored", suggestedResponsibleId: "u2" } }, nameOf),
    "Intimação registrada (somente metadados; arquivo não armazenado) · responsável sugerido: Bia.");
  const hidden = describeIntimationEvent({ id: "e", actorId: "u1", action: "confirmed", at: "", details: { deadlineId: null, deadlineIdHidden: true } }, nameOf);
  assert.match(hidden, /sem permissão de leitura/);
  assert.equal(describeIntimationEvent({ id: "e", actorId: "u1", action: "responsible_suggested", at: "", details: { fromResponsibleId: "u2", toResponsibleId: null } }, nameOf),
    "Sugestão de responsável removida.");
  const text = describeIntimationEvent({ id: "e", actorId: "u1", action: "draft_updated", at: "", details: { changes: { dueDate: { from: null, to: "2026-11-20" } } } }, nameOf);
  assert.equal(text, "Rascunho alterado: vencimento.");
});

test("cache: leituras simultâneas da mesma chave compartilham a requisição", async () => {
  const cache = createQueryCache();
  let calls = 0;
  let release;
  const gate = new Promise((r) => { release = r; });
  const fetcher = async () => { calls++; await gate; return { unread: 3 }; };
  const a = cache.dedupe("k", fetcher);
  const b = cache.dedupe("k", fetcher);
  assert.equal(cache.inflightSize, 1);
  release();
  assert.deepEqual(await a, { unread: 3 });
  assert.deepEqual(await b, { unread: 3 });
  assert.equal(calls, 1);
  assert.equal(cache.inflightSize, 0);
  await cache.dedupe("k", async () => { calls++; return 1; });
  assert.equal(calls, 2);
});
