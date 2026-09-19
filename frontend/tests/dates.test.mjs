import test from "node:test";
import assert from "node:assert/strict";
import { diffDays, addDays, formatCivil, weekdayShort } from "../src/lib/dates.mjs";

test("diffDays conta diferença em dias civis", () => {
  assert.equal(diffDays("2026-09-16", "2026-09-16"), 0);
  assert.equal(diffDays("2026-09-18", "2026-09-16"), 2);
  assert.equal(diffDays("2026-09-15", "2026-09-16"), -1);
});

test("diffDays atravessa mês e ano sem erro de fuso", () => {
  assert.equal(diffDays("2026-10-01", "2026-09-30"), 1);
  assert.equal(diffDays("2027-01-01", "2026-12-31"), 1);
});

test("addDays soma dias civis", () => {
  assert.equal(addDays("2026-09-16", 3), "2026-09-19");
  assert.equal(addDays("2026-09-30", 1), "2026-10-01");
  assert.equal(addDays("2026-09-16", -1), "2026-09-15");
});

test("formatCivil formata DD/MM/AAAA", () => {
  assert.equal(formatCivil("2026-09-16"), "16/09/2026");
});

test("weekdayShort é estável para uma data conhecida", () => {
  // 2026-09-16 é uma quarta-feira.
  assert.equal(weekdayShort("2026-09-16").toLowerCase().startsWith("qua"), true);
});
