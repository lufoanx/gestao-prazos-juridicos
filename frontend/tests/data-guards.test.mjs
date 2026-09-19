import test from "node:test";
import assert from "node:assert/strict";
import { canWriteDeadline, canCreateDeadline, canPerformOp, permissionForOp } from "../src/lib/deadline-guards.mjs";
import { ADMIN_PERMISSIONS, MEMBER_PERMISSIONS } from "../src/lib/session.mjs";

// Estes testes exercitam a MESMA lógica usada pelo DataContext (via data-ops),
// importada do módulo compartilhado — sem reimplementar a regra aqui.

const personal = (owner) => ({
  id: "d", scope: { kind: "personal", ownerId: owner }, title: "P", caseNumber: "0", court: "T",
  practiceArea: "Cível", responsibleId: owner, status: "open", priority: "normal",
  startDate: "2026-09-01", dueDate: "2026-09-20", countingMode: "business", duration: 1, reviewed: true,
});
const office = (officeId, resp) => ({ ...personal(resp), scope: { kind: "office", officeId }, responsibleId: resp });

const ctxPersonal = (owner) => ({ scope: { kind: "personal", ownerId: owner }, scopeKind: "personal", userId: owner, membership: null });
const ctxOffice = (officeId, userId, perms) => ({
  scope: { kind: "office", officeId }, scopeKind: "office", userId,
  membership: { userId, officeId, roleLabel: "x", practiceAreas: [], permissions: perms, visibility: "all" },
});

test("permissionForOp: cancelar/concluir/reabrir exigem deadline.complete; editar exige edit", () => {
  assert.equal(permissionForOp("cancel"), "deadline.complete");
  assert.equal(permissionForOp("complete"), "deadline.complete");
  assert.equal(permissionForOp("reopen"), "deadline.complete");
  assert.equal(permissionForOp("edit"), "deadline.edit");
  assert.equal(permissionForOp("comment"), "deadline.create");
  assert.equal(permissionForOp("desconhecida"), null);
});

test("prazo pessoal: dono age, outra conta é bloqueada", () => {
  const d = personal("u_A");
  assert.equal(canPerformOp(d, ctxPersonal("u_A"), "edit"), true);
  assert.equal(canPerformOp(d, ctxPersonal("u_B"), "edit"), false);
  assert.equal(canPerformOp(d, ctxPersonal("u_B"), "cancel"), false);
});

test("escritório: admin edita e cancela; membro cancela/conclui mas não edita", () => {
  const d = office("off1", "u2");
  const admin = ctxOffice("off1", "u1", ADMIN_PERMISSIONS);
  const member = ctxOffice("off1", "u2", MEMBER_PERMISSIONS);
  assert.equal(canPerformOp(d, admin, "edit"), true);
  assert.equal(canPerformOp(d, admin, "cancel"), true);
  assert.equal(canPerformOp(d, member, "edit"), false);
  assert.equal(canPerformOp(d, member, "cancel"), true);   // cancelar = complete
  assert.equal(canPerformOp(d, member, "complete"), true);
  assert.equal(canPerformOp(d, member, "comment"), true);
});

test("cancelar e concluir têm a MESMA exigência (alinhamento tela<->dados)", () => {
  const d = office("off1", "u2");
  const onlyComplete = ctxOffice("off1", "u2", ["deadline.read", "deadline.complete"]);
  assert.equal(canPerformOp(d, onlyComplete, "complete"), canPerformOp(d, onlyComplete, "cancel"));
  assert.equal(canPerformOp(d, onlyComplete, "cancel"), true);
  assert.equal(canPerformOp(d, onlyComplete, "edit"), false);
});

test("outro escritório e vazamento entre ambientes são bloqueados", () => {
  const d = office("off1", "u2");
  assert.equal(canPerformOp(d, ctxOffice("off2", "u9", ADMIN_PERMISSIONS), "edit"), false);
  assert.equal(canPerformOp(d, ctxPersonal("u2"), "edit"), false);
  const p = personal("u1");
  assert.equal(canPerformOp(p, ctxOffice("off1", "u1", ADMIN_PERMISSIONS), "edit"), false);
});

test("canCreateDeadline segue a permissão do ambiente", () => {
  assert.equal(canCreateDeadline(ctxPersonal("u1")), true);
  assert.equal(canCreateDeadline(ctxOffice("off1", "u2", MEMBER_PERMISSIONS)), true);
  assert.equal(canCreateDeadline(ctxOffice("off1", "u2", ["deadline.read"])), false);
  assert.equal(canWriteDeadline(office("off1", "u2"), ctxOffice("off1", "u1", ADMIN_PERMISSIONS), "deadline.edit"), true);
});
