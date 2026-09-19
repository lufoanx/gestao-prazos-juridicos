import test from "node:test";
import assert from "node:assert/strict";
import {
  matchesScope, filterDeadlines, sortDeadlines, paginate, distinctAreas, monthMatrix, groupByDueDate,
} from "../src/lib/deadlines-view.mjs";

const today = "2026-09-16";
const D = (id, over = {}) => ({
  id, scope: over.scope ?? { kind: "personal", ownerId: "u1" },
  title: over.title ?? id, caseNumber: over.caseNumber ?? "000",
  court: over.court ?? "TJSC", practiceArea: over.area ?? "Cível",
  responsibleId: "u1", status: over.status ?? "open", priority: over.priority ?? "normal",
  startDate: "2026-09-01", dueDate: over.dueDate ?? "2026-09-20",
  countingMode: "business", duration: 5, reviewed: true,
});

test("matchesScope isola pessoal e escritório", () => {
  const p = D("p", { scope: { kind: "personal", ownerId: "u1" } });
  const o = D("o", { scope: { kind: "office", officeId: "office-x" } });
  assert.equal(matchesScope(p, { kind: "personal", ownerId: "u1" }), true);
  assert.equal(matchesScope(p, { kind: "personal", ownerId: "u2" }), false);
  assert.equal(matchesScope(p, { kind: "office", officeId: "office-x" }), false);
  assert.equal(matchesScope(o, { kind: "office", officeId: "office-x" }), true);
  assert.equal(matchesScope(o, { kind: "office", officeId: "office-y" }), false);
});

test("filtra por status, área e busca textual", () => {
  const list = [
    D("a", { title: "Contestação", area: "Cível", status: "open" }),
    D("b", { title: "Recurso trabalhista", area: "Trabalhista", status: "completed" }),
    D("c", { title: "Réplica", area: "Cível", status: "open", caseNumber: "0099" }),
  ];
  assert.deepEqual(filterDeadlines(list, { status: "open", today }).map((d) => d.id), ["a", "c"]);
  assert.deepEqual(filterDeadlines(list, { area: "Trabalhista", today }).map((d) => d.id), ["b"]);
  assert.deepEqual(filterDeadlines(list, { query: "réplica", today }).map((d) => d.id), ["c"]);
  assert.deepEqual(filterDeadlines(list, { query: "0099", today }).map((d) => d.id), ["c"]);
});

test("filtra por urgência (apenas prazos em aberto)", () => {
  const list = [
    D("overdue", { dueDate: "2026-09-15" }),
    D("today", { dueDate: "2026-09-16" }),
    D("soon", { dueDate: "2026-09-18" }),
    D("future", { dueDate: "2026-09-30" }),
    D("doneToday", { dueDate: "2026-09-16", status: "completed" }),
  ];
  assert.deepEqual(filterDeadlines(list, { urgency: "overdue", today }).map((d) => d.id), ["overdue"]);
  assert.deepEqual(filterDeadlines(list, { urgency: "today", today }).map((d) => d.id), ["today"]);
  assert.deepEqual(filterDeadlines(list, { urgency: "soon", today }).map((d) => d.id), ["soon"]);
  // Concluído não conta como "hoje" mesmo vencendo hoje.
  assert.equal(filterDeadlines(list, { urgency: "today", today }).some((d) => d.id === "doneToday"), false);
});

test("ordena por vencimento e por título", () => {
  const list = [D("a", { dueDate: "2026-09-20", title: "Zeta" }), D("b", { dueDate: "2026-09-10", title: "Alfa" })];
  assert.deepEqual(sortDeadlines(list, "dueDate", "asc").map((d) => d.id), ["b", "a"]);
  assert.deepEqual(sortDeadlines(list, "title", "asc").map((d) => d.id), ["b", "a"]);
  assert.deepEqual(sortDeadlines(list, "dueDate", "desc").map((d) => d.id), ["a", "b"]);
});

test("paginação divide a lista e limita a página", () => {
  const list = Array.from({ length: 10 }, (_, i) => D("d" + i));
  const p1 = paginate(list, 1, 4);
  assert.equal(p1.items.length, 4);
  assert.equal(p1.pageCount, 3);
  assert.equal(p1.total, 10);
  const p9 = paginate(list, 9, 4); // além do fim → última página
  assert.equal(p9.page, 3);
  assert.equal(p9.items.length, 2);
});

test("distinctAreas retorna áreas únicas ordenadas", () => {
  const list = [D("a", { area: "Trabalhista" }), D("b", { area: "Cível" }), D("c", { area: "Cível" })];
  assert.deepEqual(distinctAreas(list), ["Cível", "Trabalhista"]);
});

test("monthMatrix tem 6 semanas de 7 dias e cobre o mês", () => {
  const weeks = monthMatrix(2026, 9);
  assert.equal(weeks.length, 6);
  assert.ok(weeks.every((w) => w.length === 7));
  // 01/09/2026 é terça → domingo anterior é 30/08.
  assert.equal(weeks[0][0], "2026-08-30");
  assert.ok(weeks.flat().includes("2026-09-16"));
});

test("groupByDueDate agrupa por data", () => {
  const list = [D("a", { dueDate: "2026-09-16" }), D("b", { dueDate: "2026-09-16" }), D("c", { dueDate: "2026-09-20" })];
  const g = groupByDueDate(list);
  assert.equal(g["2026-09-16"].length, 2);
  assert.equal(g["2026-09-20"].length, 1);
});
