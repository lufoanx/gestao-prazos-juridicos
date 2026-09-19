import test from "node:test";
import assert from "node:assert/strict";
import { buildDashboard } from "../src/lib/dashboard.mjs";
import { isUrgent, urgencyOf } from "../src/lib/urgency.mjs";
import { canReadDeadline } from "../src/lib/access.mjs";

const today = "2026-09-16";

// Fixtures locais (testes de lógica pura, sem bundler nem alias de caminho).
// Refletem a forma das sementes demonstrativas: pessoal (u1) e escritório.
const D = (id, kind, over, extra = {}) => ({
  id,
  scope: kind === "personal" ? { kind: "personal", ownerId: "u1" } : { kind: "office", officeId: "office-demo" },
  title: id, caseNumber: id, court: "x", practiceArea: "Cível",
  responsibleId: over.responsibleId ?? "u1",
  status: over.status ?? "open",
  priority: "normal", startDate: "2026-09-01", dueDate: over.dueDate,
  countingMode: "business", duration: 5, reviewed: true, ...extra,
});

const personalDeadlines = [
  D("p-overdue", "personal", { dueDate: "2026-09-15" }),
  D("p-today", "personal", { dueDate: "2026-09-16" }, { agendaTime: "11:00" }),
  D("p-soon", "personal", { dueDate: "2026-09-18" }),
  D("p-future", "personal", { dueDate: "2026-09-30" }),
  D("p-done", "personal", { dueDate: "2026-09-12", status: "completed" }),
];
const officeDeadlines = [
  D("o-overdue", "office", { dueDate: "2026-09-15", responsibleId: "u2" }),
  D("o-today", "office", { dueDate: "2026-09-16", responsibleId: "u1" }, { agendaTime: "09:30" }),
  D("o-soon", "office", { dueDate: "2026-09-17", responsibleId: "u3" }),
];
const allDeadlines = [...personalDeadlines, ...officeDeadlines];

const allIntimations = [
  { id: "i1", scope: { kind: "personal", ownerId: "u1" }, fileName: "a.pdf", status: "awaiting_review", receivedAt: "2026-09-16" },
  { id: "i2", scope: { kind: "personal", ownerId: "u1" }, fileName: "b.pdf", status: "processing", receivedAt: "2026-09-16" },
  { id: "i3", scope: { kind: "office", officeId: "office-demo" }, fileName: "c.pdf", status: "awaiting_review", receivedAt: "2026-09-16" },
  { id: "i4", scope: { kind: "office", officeId: "office-demo" }, fileName: "d.pdf", status: "failed", receivedAt: "2026-09-15" },
];

const membershipAll = {
  userId: "u1", officeId: "office-demo", roleLabel: "x", practiceAreas: [],
  permissions: ["deadline.read"], visibility: "all",
};

function inScope(rec, scope) {
  if (rec.scope.kind !== scope.kind) return false;
  if (scope.kind === "personal") return rec.scope.ownerId === scope.ownerId;
  return rec.scope.officeId === scope.officeId;
}
function forScope(scope) {
  const deadlines = allDeadlines
    .filter((d) => inScope(d, scope))
    .filter((d) => canReadDeadline("u1", membershipAll, d));
  const intimations = allIntimations.filter((i) => inScope(i, scope));
  return { deadlines, buildResult: buildDashboard(deadlines, intimations, today) };
}

test("contadores da visão geral batem com os registros das listas", () => {
  const { deadlines, buildResult } = forScope({ kind: "personal", ownerId: "u1" });
  const { overview } = buildResult;
  const open = deadlines.filter((d) => d.status === "open");
  assert.equal(overview.total, deadlines.length);
  assert.equal(overview.open, open.length);
  assert.equal(overview.completed, deadlines.filter((d) => d.status === "completed").length);
  assert.equal(overview.overdue, open.filter((d) => urgencyOf(d.dueDate, today).level === "overdue").length);
  assert.equal(overview.dueToday, open.filter((d) => urgencyOf(d.dueDate, today).level === "today").length);
  assert.equal(overview.soon, open.filter((d) => urgencyOf(d.dueDate, today).level === "soon").length);
});

test("contador 'urgent' iguala o tamanho da lista de urgentes", () => {
  const { buildResult } = forScope({ kind: "office", officeId: "office-demo" });
  assert.equal(buildResult.overview.urgent, buildResult.urgent.length);
  assert.ok(buildResult.urgent.every((d) => isUrgent(d.urgency.level)));
});

test("awaitingReview iguala o número de intimações em revisão", () => {
  const { buildResult } = forScope({ kind: "office", officeId: "office-demo" });
  assert.equal(buildResult.overview.awaitingReview, buildResult.reviews.length);
  assert.ok(buildResult.reviews.every((i) => i.status === "awaiting_review"));
});

test("agenda do dia contém apenas prazos que vencem hoje", () => {
  const { buildResult } = forScope({ kind: "personal", ownerId: "u1" });
  assert.ok(buildResult.agenda.every((d) => d.dueDate === today));
  assert.equal(buildResult.overview.dueToday, buildResult.agenda.length);
});

test("prazos concluídos não entram em urgentes nem na agenda", () => {
  const { buildResult } = forScope({ kind: "personal", ownerId: "u1" });
  const ids = [...buildResult.urgent, ...buildResult.agenda].map((d) => d.id);
  assert.ok(!ids.includes("p-done"));
});

test("isolamento de ambiente: pessoal e escritório não se misturam", () => {
  const personal = forScope({ kind: "personal", ownerId: "u1" });
  const office = forScope({ kind: "office", officeId: "office-demo" });
  assert.ok(personal.deadlines.every((d) => d.scope.kind === "personal"));
  assert.ok(office.deadlines.every((d) => d.scope.kind === "office"));
  assert.ok(personal.deadlines.length > 0 && office.deadlines.length > 0);
});

test("visibilidade 'assigned' oculta prazos de outro responsável no escritório", () => {
  const membershipAssigned = { ...membershipAll, visibility: "assigned" };
  const officeScope = { kind: "office", officeId: "office-demo" };
  const visible = allDeadlines
    .filter((d) => inScope(d, officeScope))
    .filter((d) => canReadDeadline("u1", membershipAssigned, d));
  // Só o prazo cujo responsável é u1 permanece visível.
  assert.ok(visible.every((d) => d.responsibleId === "u1"));
  assert.ok(visible.length >= 1);
});
