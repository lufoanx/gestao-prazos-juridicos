import test from "node:test";
import assert from "node:assert/strict";
import {
  opUploadIntimation, opProcessIntimation, opRetryIntimation, opRemoveIntimation,
  opConfirmIntimationReview, opMarkNotificationRead, opMarkAllNotificationsRead,
} from "../src/lib/data-ops.mjs";
import { ADMIN_PERMISSIONS, MEMBER_PERMISSIONS } from "../src/lib/session.mjs";

let n = 0;
const deps = { newId: (p) => `${p}_${++n}`, today: "2026-09-16" };

function emptyState() {
  return { version: 1, deadlines: [], comments: [], attachments: [], audit: [], notifications: [], removedAttachmentIds: [], intimations: [], removedIntimationIds: [] };
}
const seeds = { deadlines: [], attachments: [], intimations: [], notifications: [] };

const officeCtx = (officeId, userId, perms) => ({
  scope: { kind: "office", officeId }, scopeKind: "office", userId,
  membership: { userId, officeId, roleLabel: "x", practiceAreas: [], permissions: perms, visibility: "all" },
});
const personalCtx = (owner) => ({ scope: { kind: "personal", ownerId: owner }, scopeKind: "personal", userId: owner, membership: null });

const suggestion = {
  suggestedTitle: "Manifestação", suggestedCaseNumber: "0001", suggestedCourt: "TJSC",
  suggestedArea: "Cível", suggestedResponsibleId: "u1", suggestedDueDate: "2026-09-26",
};
const review = {
  title: "Manifestação revisada", caseNumber: "0001", court: "TJSC", practiceArea: "Cível",
  responsibleId: "u1", priority: "normal", startDate: "2026-09-16", dueDate: "2026-09-26",
  countingMode: "business", duration: 5,
};

test("upload exige permissão; sem create é bloqueado sem alterar estado", () => {
  const s0 = emptyState();
  const ok = opUploadIntimation(s0, personalCtx("u1"), { name: "x.pdf" }, deps);
  assert.notEqual(ok.id, null);
  assert.equal(ok.state.intimations.length, 1);
  assert.equal(ok.state.intimations[0].status, "processing");

  const noPerm = officeCtx("off1", "u2", ["deadline.read"]);
  const blocked = opUploadIntimation(s0, noPerm, { name: "y.pdf" }, deps);
  assert.equal(blocked.id, null);
  assert.equal(blocked.state, s0);
});

test("processamento: sucesso vira awaiting_review com sugestões; falha vira failed", () => {
  const up = opUploadIntimation(emptyState(), personalCtx("u1"), { name: "x.pdf" }, deps);
  const id = up.id;
  const ok = opProcessIntimation(up.state, personalCtx("u1"), id, "success", suggestion, deps, seeds);
  assert.equal(ok.intimations[0].status, "awaiting_review");
  assert.equal(ok.intimations[0].suggestedTitle, "Manifestação");

  const failed = opProcessIntimation(up.state, personalCtx("u1"), id, "fail", null, deps, seeds);
  assert.equal(failed.intimations[0].status, "failed");
});

test("processar intimação de outro ambiente é bloqueado (sem alterar estado)", () => {
  const up = opUploadIntimation(emptyState(), personalCtx("u1"), { name: "x.pdf" }, deps);
  const blocked = opProcessIntimation(up.state, personalCtx("u2"), up.id, "success", suggestion, deps, seeds);
  assert.equal(blocked, up.state);
});

test("retry só funciona a partir de failed", () => {
  const up = opUploadIntimation(emptyState(), personalCtx("u1"), { name: "x.pdf" }, deps);
  const failed = opProcessIntimation(up.state, personalCtx("u1"), up.id, "fail", null, deps, seeds);
  const retried = opRetryIntimation(failed, personalCtx("u1"), up.id, deps, seeds);
  assert.equal(retried.intimations[0].status, "processing");
  // a partir de processing, retry não faz nada
  const noop = opRetryIntimation(retried, personalCtx("u1"), up.id, deps, seeds);
  assert.equal(noop, retried);
});

test("confirmar revisão cria UM prazo vinculado + histórico + notificação", () => {
  const up = opUploadIntimation(emptyState(), personalCtx("u1"), { name: "x.pdf" }, deps);
  const ready = opProcessIntimation(up.state, personalCtx("u1"), up.id, "success", suggestion, deps, seeds);
  const res = opConfirmIntimationReview(ready, personalCtx("u1"), up.id, review, deps, seeds);
  assert.notEqual(res.deadlineId, null);
  assert.equal(res.state.deadlines.length, 1);
  assert.equal(res.state.deadlines[0].title, "Manifestação revisada");
  assert.equal(res.state.deadlines[0].scope.ownerId, "u1");
  const intim = res.state.intimations.find((i) => i.id === up.id);
  assert.equal(intim.status, "reviewed");
  assert.equal(intim.deadlineId, res.deadlineId);
  assert.ok(res.state.audit.some((a) => a.action === "created"));
  assert.ok(res.state.notifications.length >= 1);
});

test("proteção contra duplicação: confirmar de novo não cria outro prazo", () => {
  const up = opUploadIntimation(emptyState(), personalCtx("u1"), { name: "x.pdf" }, deps);
  const ready = opProcessIntimation(up.state, personalCtx("u1"), up.id, "success", suggestion, deps, seeds);
  const first = opConfirmIntimationReview(ready, personalCtx("u1"), up.id, review, deps, seeds);
  const second = opConfirmIntimationReview(first.state, personalCtx("u1"), up.id, review, deps, seeds);
  assert.equal(second.deadlineId, first.deadlineId);        // mesmo prazo
  assert.equal(second.state.deadlines.length, 1);            // não duplica
  assert.equal(second.state, first.state);                   // estado inalterado
});

test("confirmar sem permissão / fora do ambiente é bloqueado, sem criar prazo", () => {
  const up = opUploadIntimation(emptyState(), personalCtx("u1"), { name: "x.pdf" }, deps);
  const ready = opProcessIntimation(up.state, personalCtx("u1"), up.id, "success", suggestion, deps, seeds);
  const blocked = opConfirmIntimationReview(ready, personalCtx("u2"), up.id, review, deps, seeds);
  assert.equal(blocked.deadlineId, null);
  assert.equal(blocked.state, ready);
});

test("remover intimação: não confirmada some; reviewed é preservada", () => {
  const up = opUploadIntimation(emptyState(), personalCtx("u1"), { name: "x.pdf" }, deps);
  const removed = opRemoveIntimation(up.state, personalCtx("u1"), up.id, deps, seeds);
  assert.ok(removed.removedIntimationIds.includes(up.id));

  const ready = opProcessIntimation(up.state, personalCtx("u1"), up.id, "success", suggestion, deps, seeds);
  const confirmed = opConfirmIntimationReview(ready, personalCtx("u1"), up.id, review, deps, seeds);
  const tryRemove = opRemoveIntimation(confirmed.state, personalCtx("u1"), up.id, deps, seeds);
  assert.equal(tryRemove, confirmed.state); // reviewed não pode ser removida
});

test("notificações: marcar uma e todas como lidas, respeitando o ambiente", () => {
  const s = {
    ...emptyState(),
    notifications: [
      { id: "n1", scope: { kind: "personal", ownerId: "u1" }, title: "a", read: false, createdAt: "2026-09-16" },
      { id: "n2", scope: { kind: "personal", ownerId: "u1" }, title: "b", read: false, createdAt: "2026-09-16" },
      { id: "n3", scope: { kind: "office", officeId: "off1" }, title: "c", read: false, createdAt: "2026-09-16" },
    ],
  };
  const one = opMarkNotificationRead(s, personalCtx("u1"), "n1", seeds);
  assert.equal(one.notifications.find((x) => x.id === "n1").read, true);
  assert.equal(one.notifications.find((x) => x.id === "n2").read, false);
  // marcar de outro ambiente não afeta
  const cross = opMarkNotificationRead(s, personalCtx("u1"), "n3", seeds);
  assert.equal(cross, s);
  // todas do ambiente pessoal
  const all = opMarkAllNotificationsRead(s, personalCtx("u1"), seeds);
  assert.equal(all.notifications.find((x) => x.id === "n1").read, true);
  assert.equal(all.notifications.find((x) => x.id === "n2").read, true);
  assert.equal(all.notifications.find((x) => x.id === "n3").read, false); // outro ambiente intacto
});

// Espelha o processador central: o desfecho vem de demoForceFail (persistido).
const resolve = (state, ctx, id) => {
  const intim = state.intimations.find((i) => i.id === id);
  return intim.demoForceFail === true
    ? opProcessIntimation(state, ctx, id, "fail", null, deps, seeds)
    : opProcessIntimation(state, ctx, id, "success", suggestion, deps, seeds);
};

test("ciclo completo: falha → nova tentativa → revisão → confirmação", () => {
  const ctx = personalCtx("u1");
  // upload forçando falha
  const up = opUploadIntimation(emptyState(), ctx, { name: "x.pdf", demoForceFail: true }, deps);
  assert.equal(up.state.intimations[0].demoForceFail, true);
  // 1º processamento (central) → falha
  const failed = resolve(up.state, ctx, up.id);
  assert.equal(failed.intimations[0].status, "failed");
  // nova tentativa → processing, desfecho de falha limpo
  const retry = opRetryIntimation(failed, ctx, up.id, deps, seeds);
  assert.equal(retry.intimations[0].status, "processing");
  assert.equal(retry.intimations[0].demoForceFail, false);
  // reprocessamento (central) → sucesso, aguardando revisão + sugestões
  const ready = resolve(retry, ctx, up.id);
  assert.equal(ready.intimations[0].status, "awaiting_review");
  assert.equal(ready.intimations[0].suggestedTitle, "Manifestação");
  // confirmação cria UM prazo vinculado
  const res = opConfirmIntimationReview(ready, ctx, up.id, review, deps, seeds);
  assert.notEqual(res.deadlineId, null);
  assert.equal(res.state.deadlines.length, 1);
  const intim = res.state.intimations.find((i) => i.id === up.id);
  assert.equal(intim.status, "reviewed");
  assert.equal(intim.deadlineId, res.deadlineId);
  // confirmar de novo não duplica
  const again = opConfirmIntimationReview(res.state, ctx, up.id, review, deps, seeds);
  assert.equal(again.state.deadlines.length, 1);
  assert.equal(again.deadlineId, res.deadlineId);
});

test("isolamento durante o assíncrono: outra conta não resolve o processing alheio", () => {
  const owner = personalCtx("u1");
  const up = opUploadIntimation(emptyState(), owner, { name: "x.pdf", demoForceFail: true }, deps);
  const failed = resolve(up.state, owner, up.id);
  const retry = opRetryIntimation(failed, owner, up.id, deps, seeds); // volta a processing
  // conta B tenta resolver → bloqueado, estado intacto (segue processing)
  const intruder = personalCtx("u2");
  const blocked = opProcessIntimation(retry, intruder, up.id, "success", suggestion, deps, seeds);
  assert.equal(blocked, retry);
  assert.equal(blocked.intimations[0].status, "processing");
  // o dono resolve normalmente
  const ok = resolve(retry, owner, up.id);
  assert.equal(ok.intimations[0].status, "awaiting_review");
});
