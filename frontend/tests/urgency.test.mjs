import test from "node:test";
import assert from "node:assert/strict";
import { urgencyOf, isUrgent, SOON_THRESHOLD_DAYS } from "../src/lib/urgency.mjs";

const today = "2026-09-16";

test("classifica vencido / hoje / próximo / futuro", () => {
  assert.equal(urgencyOf("2026-09-15", today).level, "overdue");
  assert.equal(urgencyOf("2026-09-16", today).level, "today");
  assert.equal(urgencyOf("2026-09-18", today).level, "soon");
  assert.equal(urgencyOf("2026-09-30", today).level, "upcoming");
});

test("limiar 'próximo' respeita SOON_THRESHOLD_DAYS", () => {
  const edge = urgencyOf("2026-09-19", today); // +3 dias
  assert.equal(edge.days, SOON_THRESHOLD_DAYS);
  assert.equal(edge.level, "soon");
  assert.equal(urgencyOf("2026-09-20", today).level, "upcoming"); // +4 dias
});

test("isUrgent cobre vencido, hoje e próximo — não futuro", () => {
  assert.equal(isUrgent("overdue"), true);
  assert.equal(isUrgent("today"), true);
  assert.equal(isUrgent("soon"), true);
  assert.equal(isUrgent("upcoming"), false);
});
