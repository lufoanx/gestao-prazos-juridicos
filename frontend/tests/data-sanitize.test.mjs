import test from "node:test";
import assert from "node:assert/strict";
import { sanitizeStored, sanitizePatch, isValidScope, isValidDeadline } from "../src/lib/data-sanitize.mjs";

const good = (over = {}) => ({
  id: "d1", scope: { kind: "personal", ownerId: "u1" },
  title: "Prazo", caseNumber: "000", court: "TJSC", practiceArea: "Cível",
  responsibleId: "u1", status: "open", priority: "normal",
  startDate: "2026-09-01", dueDate: "2026-09-20", countingMode: "business", duration: 5, reviewed: true,
  ...over,
});

test("isValidScope aceita pessoal/escritório e rejeita o resto", () => {
  assert.equal(isValidScope({ kind: "personal", ownerId: "u1" }), true);
  assert.equal(isValidScope({ kind: "office", officeId: "o1" }), true);
  assert.equal(isValidScope({ kind: "personal" }), false);
  assert.equal(isValidScope({ kind: "x" }), false);
  assert.equal(isValidScope(null), false);
});

test("isValidDeadline exige campos e valores válidos", () => {
  assert.equal(isValidDeadline(good()), true);
  assert.equal(isValidDeadline(good({ status: "weird" })), false);
  assert.equal(isValidDeadline(good({ scope: { kind: "personal" } })), false);
  assert.equal(isValidDeadline(good({ duration: "5" })), false);
  assert.equal(isValidDeadline({}), false);
});

test("sanitizeStored rejeita versão incompatível", () => {
  assert.equal(sanitizeStored({ version: 2, deadlines: [] }, 1), null);
  assert.equal(sanitizeStored(null, 1), null);
  assert.equal(sanitizeStored("lixo", 1), null);
});

test("sanitizeStored descarta registros corrompidos sem quebrar", () => {
  const dirty = {
    version: 1,
    deadlines: [good(), { id: "x" }, null, good({ id: "d2", status: "nope" })],
    comments: [{ id: "c1", deadlineId: "d1", authorId: "u1", text: "oi", createdAt: "2026-09-10" }, {}],
    attachments: [{ id: "a1", deadlineId: "d1", name: "x.pdf", size: 10 }, { id: "bad" }],
    audit: [{ id: "h1", deadlineId: "d1", actorId: "u1", action: "created", createdAt: "2026-09-10" }, 5],
    notifications: [{ id: "n1", scope: { kind: "personal", ownerId: "u1" }, title: "t", read: false, createdAt: "2026-09-10" }, {}],
    removedAttachmentIds: ["a9", 3, null],
  };
  const clean = sanitizeStored(dirty, 1);
  assert.equal(clean.deadlines.length, 1);       // só o válido
  assert.equal(clean.comments.length, 1);
  assert.equal(clean.attachments.length, 1);
  assert.equal(clean.attachments[0].demoOnly, true);
  assert.equal(clean.audit.length, 1);
  assert.equal(clean.notifications.length, 1);
  assert.deepEqual(clean.removedAttachmentIds, ["a9"]);
});

test("sanitizeStored preenche arrays ausentes (estrutura completa)", () => {
  const clean = sanitizeStored({ version: 1, deadlines: [good()] }, 1);
  assert.deepEqual(clean.comments, []);
  assert.deepEqual(clean.attachments, []);
  assert.deepEqual(clean.audit, []);
  assert.deepEqual(clean.notifications, []);
  assert.deepEqual(clean.removedAttachmentIds, []);
});

test("sanitizePatch bloqueia troca de id, escopo e status", () => {
  const patch = {
    title: "Novo título", dueDate: "2026-10-01",
    id: "hack", scope: { kind: "office", officeId: "invasor" }, status: "completed",
    qualquer: "x",
  };
  const safe = sanitizePatch(patch);
  assert.equal(safe.title, "Novo título");
  assert.equal(safe.dueDate, "2026-10-01");
  assert.equal("id" in safe, false);
  assert.equal("scope" in safe, false);
  assert.equal("status" in safe, false);
  assert.equal("qualquer" in safe, false);
});

test("persistência após recarregar: round-trip preserva dados válidos", () => {
  const state = {
    version: 1,
    deadlines: [good({ id: "d1" }), good({ id: "d2", scope: { kind: "office", officeId: "off1" }, responsibleId: "u2" })],
    comments: [{ id: "c1", deadlineId: "d1", authorId: "u1", text: "nota", createdAt: "2026-09-10" }],
    attachments: [{ id: "a1", deadlineId: "d1", name: "x.pdf", size: 10, demoOnly: true }],
    audit: [{ id: "h1", deadlineId: "d1", actorId: "u1", action: "created", createdAt: "2026-09-10", details: "ok" }],
    notifications: [{ id: "n1", scope: { kind: "personal", ownerId: "u1" }, title: "t", read: false, createdAt: "2026-09-10" }],
    removedAttachmentIds: ["a9"],
  };
  const restored = sanitizeStored(JSON.parse(JSON.stringify(state)), 1); // simula localStorage
  assert.equal(restored.deadlines.length, 2);
  assert.equal(restored.comments.length, 1);
  assert.equal(restored.attachments.length, 1);
  assert.deepEqual(restored.removedAttachmentIds, ["a9"]);
  assert.equal(restored.deadlines[1].scope.officeId, "off1");
});

test("sanitizeStored valida intimações e descarta corrompidas", () => {
  const dirty = {
    version: 1, deadlines: [],
    intimations: [
      { id: "i1", scope: { kind: "personal", ownerId: "u1" }, fileName: "a.pdf", status: "awaiting_review", receivedAt: "2026-09-16" },
      { id: "i2", scope: { kind: "personal", ownerId: "u1" }, fileName: "b.pdf", status: "nope", receivedAt: "2026-09-16" }, // status inválido
      { id: "i3" }, // incompleta
    ],
    removedIntimationIds: ["i9", 2, null],
  };
  const clean = sanitizeStored(dirty, 1);
  assert.equal(clean.intimations.length, 1);
  assert.equal(clean.intimations[0].id, "i1");
  assert.deepEqual(clean.removedIntimationIds, ["i9"]);
});

test("restauração inclui intimações no round-trip", () => {
  const state = {
    version: 1, deadlines: [good({ id: "d1" })],
    intimations: [{ id: "i1", scope: { kind: "office", officeId: "off1" }, fileName: "x.pdf", status: "reviewed", receivedAt: "2026-09-10", deadlineId: "d1" }],
    removedIntimationIds: ["i7"],
  };
  const restored = sanitizeStored(JSON.parse(JSON.stringify(state)), 1);
  assert.equal(restored.intimations.length, 1);
  assert.equal(restored.intimations[0].deadlineId, "d1");
  assert.deepEqual(restored.removedIntimationIds, ["i7"]);
});
