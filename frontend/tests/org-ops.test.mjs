import test from "node:test";
import assert from "node:assert/strict";
import {
  opUpdateOffice, opSetMemberProfile, opSetMemberPermissions, opRemoveMember, opTransferAdmin,
  opLeaveOffice, opCreateInvite, opRevokeInvite, inviteState, opAcceptInvite,
  opRequestJoin, opApproveRequest, opRejectRequest, officeOfUser, ALL_PERMS, MEMBER_PERMS,
} from "../src/lib/org-ops.mjs";

const deps = (() => { let n = 0; return { newId: (p) => `${p}_${++n}`, today: "2026-09-16", addDays: (d, k) => { const t = new Date(d + "T00:00:00Z"); t.setUTCDate(t.getUTCDate() + k); return t.toISOString().slice(0, 10); } }; })();

const admin = (userId, officeId) => ({ userId, officeId, roleLabel: "Admin", practiceAreas: [], permissions: [...ALL_PERMS], visibility: "all" });
const member = (userId, officeId) => ({ userId, officeId, roleLabel: "Membro", practiceAreas: [], permissions: [...MEMBER_PERMS], visibility: "assigned" });

function baseState() {
  return {
    offices: [{ id: "off1", name: "Escritório 1" }],
    memberships: [admin("u1", "off1"), member("u2", "off1")],
    invites: [], joinRequests: [],
  };
}
const ctx = (userId) => ({ userId });

test("dados do escritório: admin edita; membro é bloqueado", () => {
  const s = baseState();
  const ok = opUpdateOffice(s, ctx("u1"), "off1", { name: "Novo Nome" });
  assert.equal(ok.offices[0].name, "Novo Nome");
  const blocked = opUpdateOffice(s, ctx("u2"), "off1", { name: "Hack" });
  assert.equal(blocked, s);
});

test("permissões: membro não aumenta as próprias permissões", () => {
  const s = baseState();
  const attempt = opSetMemberPermissions(s, ctx("u2"), "off1", "u2", [...MEMBER_PERMS, "team.manage"]);
  assert.equal(attempt, s); // bloqueado (nem tem team.manage e tentaria subir a si)
});

test("permissões: admin concede/retira de terceiros e aplica imediatamente", () => {
  const s = baseState();
  const up = opSetMemberPermissions(s, ctx("u1"), "off1", "u2", [...MEMBER_PERMS, "team.manage"]);
  const m2 = up.memberships.find((m) => m.userId === "u2");
  assert.ok(m2.permissions.includes("team.manage"));
});

test("permissões: não deixar o escritório sem administrador", () => {
  const s = baseState();
  // remover office.manage do único admin (u1) é bloqueado
  const blocked = opSetMemberPermissions(s, ctx("u1"), "off1", "u1", MEMBER_PERMS);
  assert.equal(blocked, s);
  // com dois admins, rebaixar um é permitido
  const two = { ...s, memberships: [admin("u1", "off1"), admin("u2", "off1")] };
  const ok = opSetMemberPermissions(two, ctx("u1"), "off1", "u2", MEMBER_PERMS);
  assert.ok(!ok.memberships.find((m) => m.userId === "u2").permissions.includes("office.manage"));
});

test("equipe: definir cargo, áreas e visibilidade (com permissão)", () => {
  const s = baseState();
  const ok = opSetMemberProfile(s, ctx("u1"), "off1", "u2", { roleLabel: "Sócio", practiceAreas: ["Cível"], visibility: "all" });
  const m2 = ok.memberships.find((m) => m.userId === "u2");
  assert.equal(m2.roleLabel, "Sócio");
  assert.deepEqual(m2.practiceAreas, ["Cível"]);
  assert.equal(m2.visibility, "all");
  // membro sem team.manage é bloqueado
  assert.equal(opSetMemberProfile(s, ctx("u2"), "off1", "u1", { roleLabel: "x" }), s);
});

test("remover membro: bloqueia último admin; remove membro comum", () => {
  const s = baseState();
  assert.equal(opRemoveMember(s, ctx("u1"), "off1", "u1"), s); // u1 é o único admin
  const ok = opRemoveMember(s, ctx("u1"), "off1", "u2");
  assert.ok(!ok.memberships.some((m) => m.userId === "u2"));
});

test("convites: criar, estado válido, aceitar (escritório único), revogar", () => {
  const s = baseState();
  const c = opCreateInvite(s, ctx("u1"), "off1", deps, "Advogado");
  assert.ok(c.invite);
  assert.equal(inviteState(c.invite, deps.today), "valid");
  // aceitar por usuário novo
  const acc = opAcceptInvite(c.state, { id: "u9", name: "Novo", email: "n@x" }, c.invite.token, deps);
  assert.equal(acc.officeId, "off1");
  assert.ok(acc.state.memberships.some((m) => m.userId === "u9"));
  // aceitar de novo (usado)
  const reused = opAcceptInvite(acc.state, { id: "u10", name: "Outro", email: "o@x" }, c.invite.token, deps);
  assert.equal(reused.reason, "used");
  // quem já é membro não aceita outro
  const dup = opCreateInvite(acc.state, ctx("u1"), "off1", deps);
  const blocked = opAcceptInvite(dup.state, { id: "u2", name: "Rafael", email: "r@x" }, dup.invite.token, deps);
  assert.equal(blocked.reason, "already-member");
});

test("convites: revogar e estados expirado/inválido", () => {
  const s = baseState();
  const c = opCreateInvite(s, ctx("u1"), "off1", deps);
  const rev = opRevokeInvite(c.state, ctx("u1"), c.invite.id);
  assert.equal(inviteState(rev.invites[0], deps.today), "revoked");
  // expirado
  const expired = { ...c.invite, expiresAt: "2026-09-01" };
  assert.equal(inviteState(expired, deps.today), "expired");
  assert.equal(inviteState(undefined, deps.today), "invalid");
  // revogar sem permissão
  const c2 = opCreateInvite(s, ctx("u1"), "off1", deps);
  assert.equal(opRevokeInvite(c2.state, ctx("u2"), c2.invite.id), c2.state);
});

test("solicitações: solicitar, escritório único, aprovar e rejeitar", () => {
  const s = baseState();
  const r = opRequestJoin(s, { id: "u9", name: "Novo", email: "n@x" }, "off1", deps);
  assert.ok(r.id);
  // aprovar (com permissão) adiciona membership
  const appr = opApproveRequest(r.state, ctx("u1"), r.id);
  assert.equal(appr.reason, null);
  assert.ok(appr.state.memberships.some((m) => m.userId === "u9"));
  // quem já é membro não solicita
  const dup = opRequestJoin(appr.state, { id: "u9", name: "Novo", email: "n@x" }, "off1", deps);
  assert.equal(dup.reason, "already-member");
  // rejeitar
  const r2 = opRequestJoin(s, { id: "u8", name: "X", email: "x@x" }, "off1", deps);
  const rej = opRejectRequest(r2.state, ctx("u1"), r2.id);
  assert.equal(rej.joinRequests.find((x) => x.id === r2.id).status, "rejected");
  // aprovar sem permissão é negado
  const r3 = opRequestJoin(s, { id: "u7", name: "Y", email: "y@x" }, "off1", deps);
  assert.equal(opApproveRequest(r3.state, ctx("u2"), r3.id).reason, "denied");
});

test("sair do escritório: último admin precisa transferir antes", () => {
  const s = baseState();
  assert.equal(opLeaveOffice(s, ctx("u1"), "off1"), s); // último admin bloqueado
  // transfere admin para u2, depois u1 sai
  const t = opTransferAdmin(s, ctx("u1"), "off1", "u2");
  assert.ok(t.memberships.find((m) => m.userId === "u2").permissions.includes("office.manage"));
  const left = opLeaveOffice(t, ctx("u1"), "off1");
  assert.ok(!left.memberships.some((m) => m.userId === "u1"));
  // membro comum sai livremente e pode ingressar em outro depois
  const memberLeft = opLeaveOffice(s, ctx("u2"), "off1");
  assert.ok(!memberLeft.memberships.some((m) => m.userId === "u2"));
  assert.equal(officeOfUser(memberLeft, "u2"), undefined);
});

test("bloqueios não alteram o estado (identidade preservada)", () => {
  const s = baseState();
  assert.equal(opUpdateOffice(s, ctx("u2"), "off1", { name: "x" }), s);
  assert.equal(opSetMemberPermissions(s, ctx("u2"), "off1", "u1", MEMBER_PERMS), s);
  assert.equal(opRemoveMember(s, ctx("u2"), "off1", "u1"), s);
  assert.equal(opLeaveOffice(s, ctx("u1"), "off1"), s);
});

// --- Etapa 5 (correções): fonte única do vínculo + validação de remoção ---
import { validateRemoveMember } from "../src/lib/org-ops.mjs";

test("saída deixa tombstone; reconciliação não ressuscita o vínculo encerrado", () => {
  const s = { ...baseState(), offices: [{ id: "off1", name: "E1" }, { id: "off2", name: "E2" }] };
  const left = opLeaveOffice(s, ctx("u2"), "off1");
  assert.equal(officeOfUser(left, "u2"), undefined);          // saiu
  assert.ok((left.leftKeys || []).includes("u2::off1"));       // tombstone
  // Simula reconciliação: tenta re-adicionar u2::off1 → deve ser barrado pelo tombstone.
  const tomb = new Set(left.leftKeys);
  const wouldResurrect = !tomb.has("u2::off1");
  assert.equal(wouldResurrect, false);
});

test("após sair, pode ingressar em OUTRO escritório (novo vínculo, sem restaurar o anterior)", () => {
  let s = { offices: [{ id: "off1", name: "E1" }, { id: "off2", name: "E2" }],
    memberships: [admin("u1", "off1"), member("u2", "off1"), admin("u9", "off2")], invites: [], joinRequests: [], leftKeys: [] };
  s = opLeaveOffice(s, ctx("u2"), "off1");
  assert.ok(s.leftKeys.includes("u2::off1"));
  // convite para off2, aceito por u2
  const inv = opCreateInvite(s, ctx("u9"), "off2", deps, "Advogado");
  s = inv.state;
  const acc = opAcceptInvite(s, { id: "u2", name: "U2", email: "u2@x" }, inv.invite.token, deps);
  s = acc.state;
  assert.equal(officeOfUser(s, "u2").officeId, "off2");         // novo vínculo
  assert.ok(!s.memberships.some((m) => m.userId === "u2" && m.officeId === "off1")); // não restaurou o anterior
});

test("remoção deixa tombstone (não ressuscita) e respeita último admin", () => {
  const s = baseState();
  const removed = opRemoveMember(s, ctx("u1"), "off1", "u2");
  assert.equal(officeOfUser(removed, "u2"), undefined);
  assert.ok(removed.leftKeys.includes("u2::off1"));
  // remover o último admin é bloqueado (estado idêntico)
  const s2 = { ...baseState(), memberships: [admin("u1", "off1")] };
  assert.equal(opRemoveMember(s2, ctx("u1"), "off1", "u1"), s2);
});

test("validateRemoveMember: bloqueia sem reatribuição válida; ok com reatribuição para membro ativo", () => {
  const s = baseState(); // u1 admin, u2 membro
  // u2 tem prazos em aberto (openCount=2) e sem reatribuição → bloqueado
  assert.equal(validateRemoveMember(s, "off1", "u1", "u2", 2, undefined).reason, "needs-reassign");
  // reatribuir para si mesmo (o removido) → inválido
  assert.equal(validateRemoveMember(s, "off1", "u1", "u2", 2, "u2").reason, "invalid-reassign");
  // reatribuir para não-membro → inválido
  assert.equal(validateRemoveMember(s, "off1", "u1", "u2", 2, "u404").reason, "invalid-reassign");
  // reatribuir para u1 (membro ativo) → ok
  assert.equal(validateRemoveMember(s, "off1", "u1", "u2", 2, "u1").ok, true);
  // sem prazos em aberto → ok mesmo sem reatribuição
  assert.equal(validateRemoveMember(s, "off1", "u1", "u2", 0, undefined).ok, true);
  // quem não tem team.manage → negado
  assert.equal(validateRemoveMember(s, "off1", "u2", "u1", 0, undefined).reason, "denied");
});

import { opLeaveOrTransferOffice, validateLeaveOffice } from "../src/lib/org-ops.mjs";

test("saída atômica: último admin sem sucessor é bloqueado (nada muda)", () => {
  const s = { ...baseState(), memberships: [admin("u1", "off1")] };
  assert.equal(validateLeaveOffice(s, "off1", "u1").reason, "last-admin");
  const res = opLeaveOrTransferOffice(s, ctx("u1"), "off1", undefined);
  assert.equal(res.ok, false);
  assert.equal(res.reason, "last-admin");
  assert.equal(res.state, s); // preserva vínculo/sessão (estado idêntico)
});

test("saída atômica: último admin com sucessor válido transfere e sai numa unidade", () => {
  const s = baseState(); // u1 admin, u2 membro
  const res = opLeaveOrTransferOffice(s, ctx("u1"), "off1", "u2");
  assert.equal(res.ok, true);
  assert.equal(officeOfUser(res.state, "u1"), undefined);                 // saiu
  const u2 = res.state.memberships.find((m) => m.userId === "u2" && m.officeId === "off1");
  assert.ok(u2.permissions.includes("office.manage"));                    // sucessor virou admin
  assert.ok(res.state.leftKeys.includes("u1::off1"));                     // tombstone
});

test("saída atômica: sucessor inválido (não-membro) bloqueia último admin", () => {
  const s = { ...baseState(), memberships: [admin("u1", "off1")] };
  const res = opLeaveOrTransferOffice(s, ctx("u1"), "off1", "u404");
  assert.equal(res.ok, false);
  assert.equal(res.state, s);
});

test("saída atômica: membro comum sai direto (não é último admin)", () => {
  const s = baseState();
  const res = opLeaveOrTransferOffice(s, ctx("u2"), "off1", undefined);
  assert.equal(res.ok, true);
  assert.equal(officeOfUser(res.state, "u2"), undefined);
  assert.ok(res.state.memberships.some((m) => m.userId === "u1")); // admin permanece
});
