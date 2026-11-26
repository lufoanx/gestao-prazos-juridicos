// Dashboard integrado: números = totais do servidor; urgência e "hoje" = referência do servidor.
import test from "node:test";
import assert from "node:assert/strict";
import {
  AGENDA_LIMIT, URGENT_PER_GROUP, dashboardQueries, dashboardResourceKey, fetchDashboard, summarizeDashboard,
} from "../src/lib/integration/dashboard-summary.mjs";

const REF = "2026-11-26";
const d = (id, over = {}) => ({ id, title: `Prazo ${id}`, caseNumber: "0001", court: "TJSC", dueDate: REF, agendaTime: null,
  status: "open", priority: "normal", urgency: { level: "today", days: 0 }, ...over });
const page = (items, total = items.length, referenceDate = REF) => ({ items, total, page: 1, perPage: 10, pageCount: 1, referenceDate });

test("consultas: só filtros do servidor, por ambiente, com limites fixos", () => {
  const q = dashboardQueries("office");
  assert.deepEqual(q.overdue, { scope: "office", sort: "dueDate", dir: "asc", status: "open", urgency: "overdue", perPage: URGENT_PER_GROUP });
  assert.deepEqual(q.today, { scope: "office", sort: "dueDate", dir: "asc", status: "open", urgency: "today", perPage: AGENDA_LIMIT });
  assert.equal(q.soon.urgency, "soon");
  assert.equal(q.open.status, "open");
  assert.equal(q.completed.status, "completed");
  assert.equal(q.all.status, undefined);
  for (const p of Object.values(q)) assert.ok(p.perPage >= 1 && p.perPage <= 100);   // limite do backend
  // A chave começa com "deadlines": é invalidada junto com as listas após criar/editar/concluir.
  assert.ok(dashboardResourceKey("personal").startsWith("deadlines?"));
  assert.notEqual(dashboardResourceKey("personal"), dashboardResourceKey("office"));
});

test("resumo: contadores vêm do total do servidor, não do tamanho da página", () => {
  const s = summarizeDashboard({
    overdue: page([d("a", { urgency: { level: "overdue", days: -3 } })], 14),
    today: page([d("b")], 1),
    soon: page([d("c", { urgency: { level: "soon", days: 2 } })], 5),
    open: page([d("x")], 40),
    completed: page([], 7),
    all: page([], 52),
  });
  assert.deepEqual(s.overview, { overdue: 14, dueToday: 1, soon: 5, open: 40, completed: 7, total: 52 });
  assert.equal(s.urgentTotal, 20);
  assert.equal(s.urgentHidden, 17);
  assert.deepEqual(s.urgent.map((x) => x.id), ["a", "b", "c"]);             // vencidos, hoje, próximos
  assert.equal(s.referenceDate, REF);
  assert.equal(s.consistent, true);
});

test("agenda: por horário, sem horário no fim; excedente informado", () => {
  const s = summarizeDashboard({
    overdue: page([]), soon: page([]), open: page([]), completed: page([]), all: page([]),
    today: page([d("tarde", { agendaTime: "15:00" }), d("sem"), d("manha", { agendaTime: "09:30" })], 4),
  });
  assert.deepEqual(s.agenda.map((x) => x.id), ["manha", "tarde", "sem"]);
  assert.equal(s.agendaHidden, 1);
});

test("vazio: tudo zero, nada inventado", () => {
  const empty = page([], 0);
  const s = summarizeDashboard({ overdue: empty, today: empty, soon: empty, open: empty, completed: empty, all: empty });
  assert.deepEqual(s.urgent, []);
  assert.deepEqual(s.agenda, []);
  assert.equal(s.urgentTotal, 0);
  assert.deepEqual(s.overview, { overdue: 0, dueToday: 0, soon: 0, open: 0, completed: 0, total: 0 });
});

test("virada do dia entre consultas: marcado como inconsistente (a tela pede para atualizar)", () => {
  const s = summarizeDashboard({
    overdue: page([], 0, "2026-11-26"), today: page([], 0, "2026-11-27"),
    soon: page([]), open: page([]), completed: page([]), all: page([]),
  });
  assert.equal(s.consistent, false);
});

test("fetchDashboard: seis consultas em paralelo ao cliente de prazos, sem outras chamadas", async () => {
  const calls = [];
  const client = { list: async (p) => { calls.push(p); return page([], p.status === "completed" ? 2 : 0); } };
  const s = await fetchDashboard(client, "personal");
  assert.equal(calls.length, 6);
  assert.ok(calls.every((p) => p.scope === "personal"));
  assert.equal(s.overview.completed, 2);
});
