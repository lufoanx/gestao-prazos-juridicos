import test from "node:test";
import assert from "node:assert/strict";
import { buildSearchHref } from "../src/lib/search.mjs";
import { canAccessIntimation } from "../src/lib/deadline-guards.mjs";
import { sanitizeStored } from "../src/lib/data-sanitize.mjs";
import {
  defaultSession, applySignUp, applyCreateOffice, isValidSession,
  ADMIN_PERMISSIONS, MEMBER_PERMISSIONS,
} from "../src/lib/session.mjs";

// ---------- Busca global do cabeçalho ----------
test("buildSearchHref: vazio → /app/prazos; termo → q codificado", () => {
  assert.equal(buildSearchHref(""), "/app/prazos");
  assert.equal(buildSearchHref("   "), "/app/prazos");
  assert.equal(buildSearchHref("contestação"), "/app/prazos?q=contesta%C3%A7%C3%A3o");
  assert.equal(buildSearchHref("a b & c=d"), "/app/prazos?q=a%20b%20%26%20c%3Dd");
  assert.equal(buildSearchHref("  réplica  "), "/app/prazos?q=r%C3%A9plica"); // trim
});

// ---------- Sessão: permissões conhecidas derivadas ----------
test("isValidSession reconhece TODAS as permissões admin e membro", () => {
  const base = applyCreateOffice(applySignUp(defaultSession(), { name: "Ana", email: "a@ex.com" }), { name: "Esc" });
  for (const perm of [...ADMIN_PERMISSIONS, ...MEMBER_PERMISSIONS]) {
    const s = { ...base, membership: { ...base.membership, permissions: [perm] } };
    // permissão canônica isolada não pode invalidar a sessão pela checagem de permissões
    // (pode falhar só se quebrar coerência de admin; usamos admin base, então garantimos o vínculo)
    const full = { ...base, membership: { ...base.membership, permissions: [...new Set([...ADMIN_PERMISSIONS, perm])] } };
    assert.equal(isValidSession(full), true, `permissão ${perm} deveria ser reconhecida`);
    void s;
  }
  // permissão desconhecida invalida
  const bad = { ...base, membership: { ...base.membership, permissions: [...ADMIN_PERMISSIONS, "deadline.hack"] } };
  assert.equal(isValidSession(bad), false);
});

// ---------- Intimações: acesso durante "processing" ----------
const inti = (over = {}) => ({ id: "i1", scope: { kind: "office", officeId: "off1" }, fileName: "a.pdf", status: "processing", receivedAt: "2026-09-16", ...over });
const ctxOffice = (userId, visibility, perms = ["deadline.read", "deadline.create"]) => ({
  scope: { kind: "office", officeId: "off1" }, scopeKind: "office", userId,
  membership: { userId, officeId: "off1", roleLabel: "x", practiceAreas: [], permissions: perms, visibility },
});

test("intimação em processing: autor (createdBy) acompanha; outro assigned não vê", () => {
  const pend = inti({ createdBy: "u1" }); // ainda sem suggestedResponsibleId/deadlineId
  assert.equal(canAccessIntimation(pend, ctxOffice("u1", "assigned")), true);   // autor vê
  assert.equal(canAccessIntimation(pend, ctxOffice("u2", "assigned")), false);  // outro assigned não vê
  assert.equal(canAccessIntimation(pend, ctxOffice("u2", "all")), true);        // visibilidade all vê
});

test("intimação em processing: outro escritório e sem permissão são bloqueados", () => {
  const pend = inti({ createdBy: "u1" });
  const outsider = { scope: { kind: "office", officeId: "off2" }, scopeKind: "office", userId: "u9",
    membership: { userId: "u9", officeId: "off2", roleLabel: "x", practiceAreas: [], permissions: ["deadline.read"], visibility: "all" } };
  assert.equal(canAccessIntimation(pend, outsider), false);
  assert.equal(canAccessIntimation(pend, ctxOffice("u1", "all", [])), false); // sem deadline.read
});

test("intimação: consistência do predicado entre dashboard/lista/assistente", () => {
  // Todos usam canAccessIntimation com o MESMO resolver → mesmo conjunto visível.
  const list = [
    inti({ id: "a", createdBy: "u1", status: "processing" }),
    inti({ id: "b", suggestedResponsibleId: "u2", status: "awaiting_review" }),
    inti({ id: "c", status: "reviewed", deadlineId: "d9", suggestedResponsibleId: "u3" }),
  ];
  const resolve = (id) => (id === "d9" ? "u1" : undefined);
  const ctx = ctxOffice("u1", "assigned");
  const visible = list.filter((i) => canAccessIntimation(i, ctx, resolve)).map((i) => i.id);
  assert.deepEqual(visible, ["a", "c"]); // autor de "a"; responsável do prazo vinculado de "c"
});

// ---------- Migração de dados persistidos ----------
const good = () => ({
  id: "d1", scope: { kind: "personal", ownerId: "u1" }, title: "P", caseNumber: "1", court: "T",
  practiceArea: "Cível", responsibleId: "u1", status: "open", priority: "normal",
  startDate: "2026-09-01", dueDate: "2026-09-20", countingMode: "business", duration: 5, reviewed: true,
});

test("migração: versão ATUAL restaura preservando registros válidos", () => {
  const out = sanitizeStored({ version: 1, deadlines: [good()] }, 1);
  assert.equal(out.deadlines.length, 1);
  assert.equal(out.version, 1);
});

test("migração: versão ANTERIOR é migrada (não descarta dados válidos)", () => {
  const out = sanitizeStored({ version: 0, deadlines: [good()] }, 1);
  assert.notEqual(out, null);
  assert.equal(out.version, 1);               // normaliza para a atual
  assert.equal(out.deadlines.length, 1);      // preserva o válido
});

test("migração: versão FUTURA ou payload inválido → fallback seguro (null)", () => {
  assert.equal(sanitizeStored({ version: 2, deadlines: [good()] }, 1), null); // futura
  assert.equal(sanitizeStored({ deadlines: [good()] }, 1), null);            // sem versão
  assert.equal(sanitizeStored("lixo", 1), null);
});

test("migração: isolamento preservado — cada registro mantém seu scope", () => {
  const personal = { ...good(), id: "p", scope: { kind: "personal", ownerId: "u1" } };
  const office = { ...good(), id: "o", scope: { kind: "office", officeId: "off1" } };
  const out = sanitizeStored({ version: 0, deadlines: [personal, office] }, 1);
  assert.equal(out.deadlines.find((d) => d.id === "p").scope.ownerId, "u1");
  assert.equal(out.deadlines.find((d) => d.id === "o").scope.officeId, "off1");
});
