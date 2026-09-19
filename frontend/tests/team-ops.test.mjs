import test from "node:test";
import assert from "node:assert/strict";
import { coordinateRemoveMember, openOfficeDeadlinesFor } from "../src/lib/team-ops.mjs";
import { officeOfUser } from "../src/lib/org-ops.mjs";

const deps = (() => { let n = 0; return { newId: (p) => `${p}_${++n}`, today: "2026-09-16" }; })();
const seeds = { deadlines: [], attachments: [], intimations: [], notifications: [] };

const ALL = ["deadline.read", "deadline.create", "deadline.edit", "deadline.complete", "deadline.transfer", "team.manage", "office.manage"];
const admin = (userId, officeId, perms = ALL) => ({ userId, officeId, roleLabel: "Adm", practiceAreas: [], permissions: [...perms], visibility: "all" });
const member = (userId, officeId) => ({ userId, officeId, roleLabel: "Membro", practiceAreas: [], permissions: ["deadline.read", "deadline.create", "deadline.edit", "deadline.complete"], visibility: "assigned" });

function orgState() {
  return { offices: [{ id: "off1", name: "E1" }], memberships: [admin("u1", "off1"), member("u2", "off1"), member("u3", "off1")], invites: [], joinRequests: [], leftKeys: [] };
}
const od = (id, resp, status = "open") => ({ id, scope: { kind: "office", officeId: "off1" }, title: id, caseNumber: "1", court: "T", practiceArea: "Cível", responsibleId: resp, status, priority: "normal", startDate: "2026-09-01", dueDate: "2026-09-20", countingMode: "business", duration: 5, reviewed: true });
function dataState() {
  return { version: 1, deadlines: [od("o1", "u2"), od("o2", "u2", "completed"), od("o3", "u3")], comments: [], attachments: [], audit: [], notifications: [], removedAttachmentIds: [], intimations: [], removedIntimationIds: [] };
}

test("coordenada: remove com reatribuição dos prazos EM ABERTO (uma unidade)", () => {
  const org = orgState(); const data = dataState();
  const res = coordinateRemoveMember(org, data, "u1", { officeId: "off1", userId: "u2", reassignTo: "u3" }, deps, seeds);
  assert.equal(res.ok, true);
  assert.equal(officeOfUser(res.org, "u2"), undefined);                 // removido
  assert.ok(res.org.leftKeys.includes("u2::off1"));                     // tombstone
  assert.equal(res.data.deadlines.find((d) => d.id === "o1").responsibleId, "u3"); // aberto reatribuído
  assert.equal(res.data.deadlines.find((d) => d.id === "o2").responsibleId, "u2"); // concluído intacto
  assert.ok(res.data.audit.some((a) => a.action === "reassigned"));
});

test("coordenada: gestor com team.manage SEM deadline.edit consegue remover+reatribuir", () => {
  const org = { ...orgState(), memberships: [admin("u1", "off1", ["deadline.read", "team.manage", "office.manage"]), member("u2", "off1"), member("u3", "off1")] };
  const data = dataState();
  const res = coordinateRemoveMember(org, data, "u1", { officeId: "off1", userId: "u2", reassignTo: "u3" }, deps, seeds);
  assert.equal(res.ok, true);
  assert.equal(res.data.deadlines.find((d) => d.id === "o1").responsibleId, "u3");
});

test("coordenada: destinatário inválido (não-membro / o próprio removido) bloqueia; nada muda", () => {
  const org = orgState(); const data = dataState();
  const a = coordinateRemoveMember(org, data, "u1", { officeId: "off1", userId: "u2", reassignTo: "u404" }, deps, seeds);
  assert.equal(a.ok, false); assert.equal(a.reason, "invalid-reassign");
  assert.equal(a.org, org); assert.equal(a.data, data); // identidade preservada
  const b = coordinateRemoveMember(org, data, "u1", { officeId: "off1", userId: "u2", reassignTo: "u2" }, deps, seeds);
  assert.equal(b.ok, false); assert.equal(b.reason, "invalid-reassign");
  assert.equal(b.org, org); assert.equal(b.data, data);
});

test("coordenada: sem reatribuição havendo prazos em aberto bloqueia; nada muda", () => {
  const org = orgState(); const data = dataState();
  const res = coordinateRemoveMember(org, data, "u1", { officeId: "off1", userId: "u2", reassignTo: undefined }, deps, seeds);
  assert.equal(res.ok, false); assert.equal(res.reason, "needs-reassign");
  assert.equal(res.org, org); assert.equal(res.data, data);
});

test("coordenada: sem team.manage bloqueia; nada muda", () => {
  const org = orgState(); const data = dataState();
  const res = coordinateRemoveMember(org, data, "u2", { officeId: "off1", userId: "u3", reassignTo: "u1" }, deps, seeds);
  assert.equal(res.ok, false); assert.equal(res.reason, "denied");
  assert.equal(res.org, org); assert.equal(res.data, data);
});

test("coordenada: sem prazos em aberto remove sem exigir reatribuição", () => {
  const org = orgState();
  const data = { ...dataState(), deadlines: [od("o3", "u3")] }; // u2 sem prazos
  const res = coordinateRemoveMember(org, data, "u1", { officeId: "off1", userId: "u2", reassignTo: undefined }, deps, seeds);
  assert.equal(res.ok, true);
  assert.equal(officeOfUser(res.org, "u2"), undefined);
  assert.equal(res.data, data); // nada a reatribuir → data inalterado
});

test("openOfficeDeadlinesFor conta só abertos do escritório do responsável", () => {
  const data = dataState();
  assert.equal(openOfficeDeadlinesFor(data, seeds, "off1", "u2").length, 1);
  assert.equal(openOfficeDeadlinesFor(data, seeds, "off1", "u3").length, 1);
});
