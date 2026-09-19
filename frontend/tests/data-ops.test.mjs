import test from "node:test";
import assert from "node:assert/strict";
import {
  opCreateDeadline, opUpdateDeadline, opSetStatus, opAddComment, opAddAttachment, opRemoveAttachment,
} from "../src/lib/data-ops.mjs";
import { ADMIN_PERMISSIONS, MEMBER_PERMISSIONS } from "../src/lib/session.mjs";

// deps determinísticos para asserts estáveis
let n = 0;
const deps = { newId: (p) => `${p}_${++n}`, today: "2026-09-16" };

const officeDeadline = (id, officeId, resp) => ({
  id, scope: { kind: "office", officeId }, title: "Contestação", caseNumber: "0001", court: "TJSC",
  practiceArea: "Cível", responsibleId: resp, status: "open", priority: "normal",
  startDate: "2026-09-01", dueDate: "2026-09-20", countingMode: "business", duration: 5, reviewed: true,
});
function baseState(deadline) {
  return { version: 1, deadlines: [deadline], comments: [], attachments: [], audit: [], notifications: [], removedAttachmentIds: [] };
}
const seeds = { deadlines: [], attachments: [] };

const admin = (officeId, userId) => ({
  scope: { kind: "office", officeId }, scopeKind: "office", userId,
  membership: { userId, officeId, roleLabel: "Adm", practiceAreas: [], permissions: ADMIN_PERMISSIONS, visibility: "all" },
});
const member = (officeId, userId) => ({
  scope: { kind: "office", officeId }, scopeKind: "office", userId,
  membership: { userId, officeId, roleLabel: "Membro", practiceAreas: [], permissions: MEMBER_PERMISSIONS, visibility: "all" },
});
const outsider = (officeId, userId) => ({
  scope: { kind: "office", officeId }, scopeKind: "office", userId,
  membership: { userId, officeId, roleLabel: "Adm", practiceAreas: [], permissions: ADMIN_PERMISSIONS, visibility: "all" },
});

test("criar: permitido grava prazo + histórico; bloqueado não muda nada", () => {
  const s0 = baseState(officeDeadline("d1", "off1", "u2"));
  const ok = opCreateDeadline(s0, admin("off1", "u1"), {
    title: "Novo", caseNumber: "9", court: "TJSC", practiceArea: "Cível", priority: "normal",
    startDate: "2026-09-10", dueDate: "2026-09-25", countingMode: "business", duration: 3,
  }, deps);
  assert.notEqual(ok.id, null);
  assert.equal(ok.state.deadlines.length, 2);
  assert.equal(ok.state.audit.length, 1);

  const noPerm = { scope: { kind: "office", officeId: "off1" }, scopeKind: "office", userId: "u5",
    membership: { userId: "u5", officeId: "off1", roleLabel: "x", practiceAreas: [], permissions: ["deadline.read"], visibility: "all" } };
  const blocked = opCreateDeadline(s0, noPerm, { title: "X", caseNumber: "1", court: "T", practiceArea: "Cível", priority: "normal", startDate: "2026-09-10", dueDate: "2026-09-25", countingMode: "business", duration: 1 }, deps);
  assert.equal(blocked.id, null);
  assert.equal(blocked.state, s0); // MESMO estado, sem alteração
});

test("editar: admin altera campos; membro é bloqueado sem tocar estado/histórico", () => {
  const s0 = baseState(officeDeadline("d1", "off1", "u2"));
  const edited = opUpdateDeadline(s0, admin("off1", "u1"), "d1", { title: "Alterado", dueDate: "2026-10-01" }, deps, seeds);
  assert.equal(edited.deadlines[0].title, "Alterado");
  assert.equal(edited.deadlines[0].dueDate, "2026-10-01");
  assert.equal(edited.audit.length, 1);

  const blocked = opUpdateDeadline(s0, member("off1", "u2"), "d1", { title: "Hack" }, deps, seeds);
  assert.equal(blocked, s0);           // bloqueado → mesmo estado
  assert.equal(blocked.audit.length, 0);
});

test("editar não muda id, escopo nem status (whitelist)", () => {
  const s0 = baseState(officeDeadline("d1", "off1", "u2"));
  const edited = opUpdateDeadline(s0, admin("off1", "u1"), "d1",
    { id: "hack", scope: { kind: "office", officeId: "invasor" }, status: "completed", title: "Ok" }, deps, seeds);
  assert.equal(edited.deadlines[0].id, "d1");
  assert.equal(edited.deadlines[0].scope.officeId, "off1");
  assert.equal(edited.deadlines[0].status, "open");
  assert.equal(edited.deadlines[0].title, "Ok");
});

test("status: membro cancela (=complete); sem permissão é bloqueado", () => {
  const s0 = baseState(officeDeadline("d1", "off1", "u2"));
  const cancelled = opSetStatus(s0, member("off1", "u2"), "d1", "cancelled", deps, seeds);
  assert.equal(cancelled.deadlines[0].status, "cancelled");
  assert.equal(cancelled.audit.length, 1);

  const noComplete = { scope: { kind: "office", officeId: "off1" }, scopeKind: "office", userId: "u7",
    membership: { userId: "u7", officeId: "off1", roleLabel: "x", practiceAreas: [], permissions: ["deadline.read", "deadline.edit"], visibility: "all" } };
  const blocked = opSetStatus(s0, noComplete, "d1", "cancelled", deps, seeds);
  assert.equal(blocked, s0);
});

test("comentar/anexar: outro escritório é bloqueado sem alterar dados nem histórico", () => {
  const s0 = baseState(officeDeadline("d1", "off1", "u2"));
  const c = opAddComment(s0, outsider("off2", "u9"), "d1", "invasão", deps, seeds);
  assert.equal(c, s0);
  assert.equal(c.comments.length, 0);
  const a = opAddAttachment(s0, outsider("off2", "u9"), "d1", { name: "x.pdf", size: 10 }, deps, seeds);
  assert.equal(a, s0);
  assert.equal(a.attachments.length, 0);
  assert.equal(a.audit.length, 0);
});

test("anexar/remover: admin adiciona e remove com histórico", () => {
  const s0 = baseState(officeDeadline("d1", "off1", "u2"));
  const withAtt = opAddAttachment(s0, admin("off1", "u1"), "d1", { name: "peca.pdf", size: 2048 }, deps, seeds);
  assert.equal(withAtt.attachments.length, 1);
  const attId = withAtt.attachments[0].id;
  const removed = opRemoveAttachment(withAtt, admin("off1", "u1"), attId, deps, seeds);
  assert.equal(removed.attachments.length, 0);
  assert.ok(removed.removedAttachmentIds.includes(attId));
  assert.equal(removed.audit.length, 2); // attached + removed_attachment

  // remover anexo por conta de outro escritório é bloqueado
  const blocked = opRemoveAttachment(withAtt, outsider("off2", "u9"), attId, deps, seeds);
  assert.equal(blocked, withAtt);
});

// ----- Transferência pessoal → escritório (Etapa 5) -----
import { opTransferDeadlineToOffice } from "../src/lib/data-ops.mjs";

const personalDeadline2 = (id, owner) => ({
  id, scope: { kind: "personal", ownerId: owner }, title: "Pessoal", caseNumber: "9", court: "T",
  practiceArea: "Cível", responsibleId: owner, status: "open", priority: "normal",
  startDate: "2026-09-01", dueDate: "2026-09-20", countingMode: "business", duration: 3, reviewed: true,
});
function stateWithPersonal() {
  return {
    version: 1,
    deadlines: [personalDeadline2("d1", "u1")],
    comments: [{ id: "c1", deadlineId: "d1", authorId: "u1", text: "nota", createdAt: "2026-09-10" }],
    attachments: [{ id: "a1", deadlineId: "d1", name: "x.pdf", size: 10, demoOnly: true }],
    audit: [{ id: "h1", deadlineId: "d1", actorId: "u1", action: "created", createdAt: "2026-09-10", details: "ok" }],
    notifications: [], removedAttachmentIds: [],
    intimations: [{ id: "i1", scope: { kind: "personal", ownerId: "u1" }, fileName: "x.pdf", status: "reviewed", receivedAt: "2026-09-10", deadlineId: "d1" }],
    removedIntimationIds: [],
  };
}
const officeCtxT = (officeId, userId, perms) => ({
  scope: { kind: "office", officeId }, scopeKind: "office", userId,
  membership: { userId, officeId, roleLabel: "x", practiceAreas: [], permissions: perms, visibility: "all" },
});

test("transferência move o MESMO registro e a intimação vinculada, sem duplicar", () => {
  const s = stateWithPersonal();
  const ctx = officeCtxT("off1", "u1", ["deadline.read", "deadline.create", "deadline.edit", "deadline.complete", "deadline.transfer"]);
  const out = opTransferDeadlineToOffice(s, ctx, "d1", "off1", deps, seeds);
  assert.equal(out.deadlines.length, 1);                 // não duplica
  assert.equal(out.deadlines[0].id, "d1");               // mesmo id
  assert.equal(out.deadlines[0].scope.kind, "office");
  assert.equal(out.deadlines[0].scope.officeId, "off1");
  // comentários/anexos/histórico seguem o mesmo deadlineId
  assert.equal(s.comments[0].deadlineId, "d1");
  assert.equal(s.attachments[0].deadlineId, "d1");
  assert.ok(out.audit.some((a) => a.action === "transferred"));
  // intimação vinculada acompanha
  assert.equal(out.intimations[0].scope.kind, "office");
  assert.equal(out.intimations[0].deadlineId, "d1");
});

test("transferência bloqueada sem deadline.transfer ou por não-dono (estado intacto)", () => {
  const s = stateWithPersonal();
  const noPerm = officeCtxT("off1", "u1", ["deadline.read", "deadline.edit"]);
  assert.equal(opTransferDeadlineToOffice(s, noPerm, "d1", "off1", deps, seeds), s);
  const notOwner = officeCtxT("off1", "u2", ["deadline.transfer"]);
  assert.equal(opTransferDeadlineToOffice(s, notOwner, "d1", "off1", deps, seeds), s);
});

test("transferência funciona a partir do escopo PESSOAL (guarda por vínculo, não por escopo)", () => {
  const s = stateWithPersonal();
  // Usuário vê o prazo pessoal (escopo pessoal), mas tem vínculo de escritório com deadline.transfer.
  const ctx = {
    scope: { kind: "personal", ownerId: "u1" }, scopeKind: "personal", userId: "u1",
    membership: { userId: "u1", officeId: "off1", roleLabel: "Adm", practiceAreas: [], permissions: ["deadline.read", "deadline.transfer"], visibility: "all" },
  };
  const out = opTransferDeadlineToOffice(s, ctx, "d1", "off1", deps, seeds);
  assert.equal(out.deadlines[0].scope.kind, "office");
  assert.equal(out.deadlines[0].scope.officeId, "off1");
  // não duplica; comentários e anexos permanecem no mesmo registro
  assert.equal(out.deadlines.length, 1);
  assert.equal(out.comments.length, 1);
  assert.equal(out.attachments.length, 1);
  assert.ok(out.audit.some((a) => a.action === "transferred"));
});

test("transferência para escritório diferente do vínculo é bloqueada (estado intacto)", () => {
  const s = stateWithPersonal();
  const ctx = {
    scope: { kind: "personal", ownerId: "u1" }, scopeKind: "personal", userId: "u1",
    membership: { userId: "u1", officeId: "off1", roleLabel: "Adm", practiceAreas: [], permissions: ["deadline.transfer"], visibility: "all" },
  };
  // tenta transferir para off2 (não é o escritório do vínculo)
  assert.equal(opTransferDeadlineToOffice(s, ctx, "d1", "off2", deps, seeds), s);
});

// ----- Reatribuição de responsável no escritório (remoção de membro) -----
import { opReassignResponsibleForOffice } from "../src/lib/data-ops.mjs";

function officeStateForReassign() {
  return {
    version: 1,
    deadlines: [
      { id: "o1", scope: { kind: "office", officeId: "off1" }, title: "A", caseNumber: "1", court: "T", practiceArea: "Cível", responsibleId: "u2", status: "open", priority: "normal", startDate: "2026-09-01", dueDate: "2026-09-20", countingMode: "business", duration: 5, reviewed: true },
      { id: "o2", scope: { kind: "office", officeId: "off1" }, title: "B", caseNumber: "2", court: "T", practiceArea: "Cível", responsibleId: "u2", status: "completed", priority: "normal", startDate: "2026-09-01", dueDate: "2026-09-10", countingMode: "business", duration: 5, reviewed: true },
      { id: "p1", scope: { kind: "personal", ownerId: "u2" }, title: "P", caseNumber: "3", court: "T", practiceArea: "Cível", responsibleId: "u2", status: "open", priority: "normal", startDate: "2026-09-01", dueDate: "2026-09-20", countingMode: "business", duration: 5, reviewed: true },
    ],
    comments: [], attachments: [], audit: [], notifications: [], removedAttachmentIds: [], intimations: [], removedIntimationIds: [],
  };
}

test("reatribuição move só prazos EM ABERTO do escritório; NÃO exige deadline.edit", () => {
  const s = officeStateForReassign();
  // Gestor de equipe SEM deadline.edit (só team.manage) — a reatribuição não depende disso.
  const ctx = { scope: { kind: "office", officeId: "off1" }, scopeKind: "office", userId: "u1",
    membership: { userId: "u1", officeId: "off1", roleLabel: "Adm", practiceAreas: [], permissions: ["deadline.read", "team.manage"], visibility: "all" } };
  const out = opReassignResponsibleForOffice(s, ctx, "off1", "u2", "u1", deps, seeds);
  assert.equal(out.deadlines.find((d) => d.id === "o1").responsibleId, "u1"); // aberto → reatribuído
  assert.equal(out.deadlines.find((d) => d.id === "o2").responsibleId, "u2"); // concluído → intacto
  assert.equal(out.deadlines.find((d) => d.id === "p1").responsibleId, "u2"); // pessoal → intacto
  assert.ok(out.audit.some((a) => a.action === "reassigned"));
});

test("reatribuição sem destino ou destino igual à origem não altera nada", () => {
  const s = officeStateForReassign();
  const ctx = { scope: { kind: "office", officeId: "off1" }, scopeKind: "office", userId: "u1",
    membership: { userId: "u1", officeId: "off1", roleLabel: "Adm", practiceAreas: [], permissions: ["team.manage"], visibility: "all" } };
  assert.equal(opReassignResponsibleForOffice(s, ctx, "off1", "u2", "", deps, seeds), s);
  assert.equal(opReassignResponsibleForOffice(s, ctx, "off1", "u2", "u2", deps, seeds), s);
});
