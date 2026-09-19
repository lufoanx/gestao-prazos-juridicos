import test from "node:test";
import assert from "node:assert/strict";
import {
  defaultSession, isValidSession, applySignUp, applySignIn, applyAutonomo,
  applyCreateOffice, canAcceptInvite, applyAcceptInvite, resetSession,
  defaultScopeKind, DEMO_USER_ID,
  ADMIN_PERMISSIONS, MEMBER_PERMISSIONS,
} from "../src/lib/session.mjs";
import { canReadDeadline } from "../src/lib/access.mjs";

const OFFICE = { id: "office-demo", name: "Escritório Demonstrativo" };

test("sessão padrão é válida, vazia e sem escritório", () => {
  const s = defaultSession();
  assert.equal(isValidSession(s), true);
  assert.equal(s.user, null);
  assert.equal(s.office, null);
  assert.equal(s.membership, null);
  assert.equal(s.profile, null);
});

test("cadastro guarda nome e e-mail, nunca senha", () => {
  const s = applySignUp(defaultSession(), { name: " Ana Lima ", email: " ana@ex.com " });
  assert.match(s.user.id, /^u_/); // id próprio derivado do e-mail (não fixo)
  assert.notEqual(s.user.id, DEMO_USER_ID);
  assert.equal(s.user.name, "Ana Lima");
  assert.equal(s.user.email, "ana@ex.com");
  assert.equal(s.profile, null);
  assert.equal(s.office, null);
  // Nenhum campo de senha em qualquer lugar da sessão.
  const json = JSON.stringify(s).toLowerCase();
  assert.equal(json.includes("senha"), false);
  assert.equal(json.includes("password"), false);
  assert.equal("pw" in s.user, false);
});

test("login identifica a sessão sem senha e usa nome informado quando não há", () => {
  const s = applySignIn(defaultSession(), { email: "jose@ex.com", name: "José" });
  assert.equal(s.user.email, "jose@ex.com");
  assert.equal(s.user.name, "José");
  assert.equal(JSON.stringify(s).toLowerCase().includes("password"), false);
});

test("login preserva o nome do cadastro anterior", () => {
  const s1 = applySignUp(defaultSession(), { name: "Ana Lima", email: "ana@ex.com" });
  const s2 = applySignIn(s1, { email: "ana@ex.com", name: "Outro Nome" });
  assert.equal(s2.user.name, "Ana Lima");
});

test("autônomo não recebe vínculo de escritório e mescla preferências", () => {
  const s = applyAutonomo(applySignUp(defaultSession(), { name: "Ana", email: "a@ex.com" }), { practiceArea: "Cível", digest: "weekly" });
  assert.equal(s.profile, "autonomo");
  assert.equal(s.office, null);
  assert.equal(s.membership, null);
  assert.equal(s.preferences.practiceArea, "Cível");
  assert.equal(s.preferences.digest, "weekly");
  assert.equal(defaultScopeKind(s), "personal");
});

test("criar escritório entra como administrador do ambiente criado", () => {
  const s = applyCreateOffice(applySignUp(defaultSession(), { name: "Ana", email: "a@ex.com" }), { name: "Andrade Advocacia" });
  assert.equal(s.profile, "office-admin");
  assert.match(s.office.id, /^office_/);
  assert.equal(s.office.name, "Andrade Advocacia");
  assert.equal(s.membership.userId, s.user.id); // dono do escritório = usuário atual (id próprio)
  assert.equal(s.membership.officeId, s.office.id);
  assert.deepEqual([...s.membership.permissions].sort(), [...ADMIN_PERMISSIONS].sort());
  assert.equal(s.membership.permissions.includes("office.manage"), true);
  assert.equal(defaultScopeKind(s), "office");
});

test("ingressar por convite entra como membro (permissões limitadas)", () => {
  const s = applyAcceptInvite(applySignUp(defaultSession(), { name: "Ana", email: "a@ex.com" }), OFFICE);
  assert.equal(s.profile, "office-member");
  assert.equal(s.office.id, OFFICE.id);
  assert.deepEqual([...s.membership.permissions].sort(), [...MEMBER_PERMISSIONS].sort());
  assert.equal(s.membership.permissions.includes("office.manage"), false);
  assert.equal(s.membership.permissions.includes("team.manage"), false);
  assert.equal(defaultScopeKind(s), "office");
});

test("no máximo um escritório por pessoa", () => {
  const withOffice = applyCreateOffice(defaultSession(), { name: "Escritório A" });
  // Tentar ingressar em outro escritório é bloqueado.
  const check = canAcceptInvite(withOffice, "outro-escritorio");
  assert.equal(check.ok, false);
  assert.equal(check.reason, "second-office");
  assert.throws(() => applyAcceptInvite(withOffice, { id: "outro-escritorio", name: "B" }), /second-office/);
  // Mesmo escritório → já é membro.
  const same = canAcceptInvite(withOffice, withOffice.office.id);
  assert.equal(same.reason, "already-member");
});

test("convite é aceitável quando não há escritório", () => {
  assert.equal(canAcceptInvite(defaultSession(), OFFICE.id).ok, true);
});

test("ingressar em escritório preserva os prazos pessoais como privados", () => {
  const s = applyAcceptInvite(defaultSession(), OFFICE);
  const personal = { id: "p1", scope: { kind: "personal", ownerId: DEMO_USER_ID }, responsibleId: DEMO_USER_ID, status: "open" };
  const officeD = { id: "o1", scope: { kind: "office", officeId: OFFICE.id }, responsibleId: "u2", status: "open" };
  const all = [personal, officeD];

  const inScope = (rec, scope) =>
    rec.scope.kind === scope.kind &&
    (scope.kind === "personal" ? rec.scope.ownerId === scope.ownerId : rec.scope.officeId === scope.officeId);

  // No ambiente de escritório, o prazo pessoal NUNCA aparece.
  const officeScope = { kind: "office", officeId: OFFICE.id };
  const officeVisible = all.filter((d) => inScope(d, officeScope)).filter((d) => canReadDeadline(DEMO_USER_ID, s.membership, d));
  assert.equal(officeVisible.some((d) => d.id === "p1"), false);
  assert.equal(officeVisible.some((d) => d.id === "o1"), true);

  // No ambiente pessoal, só o prazo pessoal do dono aparece.
  const personalScope = { kind: "personal", ownerId: DEMO_USER_ID };
  const personalVisible = all.filter((d) => inScope(d, personalScope));
  assert.deepEqual(personalVisible.map((d) => d.id), ["p1"]);
});

test("reset limpa a sessão", () => {
  const s = applyCreateOffice(applySignUp(defaultSession(), { name: "Ana", email: "a@ex.com" }), { name: "X" });
  const r = resetSession();
  assert.equal(r.user, null);
  assert.equal(r.office, null);
  assert.equal(r.profile, null);
  assert.notEqual(s.office, null); // garante que o original não foi mutado
});

// --- Cenários adicionais (bloqueio de criação, login sem herança, restauração) ---
import { canCreateOffice, SESSION_VERSION } from "../src/lib/session.mjs";

test("criar escritório é bloqueado quando já há vínculo ativo (sem substituir)", () => {
  const admin = applyCreateOffice(defaultSession(), { name: "Escritório A" });
  // canCreateOffice sinaliza bloqueio
  const check = canCreateOffice(admin);
  assert.equal(check.ok, false);
  assert.equal(check.reason, "already-office");
  // applyCreateOffice lança e NÃO substitui o escritório existente
  assert.throws(() => applyCreateOffice(admin, { name: "Escritório B" }), /already-office/);
  assert.equal(admin.office.name, "Escritório A");
});

test("criar escritório é permitido quando não há vínculo", () => {
  assert.equal(canCreateOffice(defaultSession()).ok, true);
  const s = applyCreateOffice(defaultSession(), { name: "Novo" });
  assert.equal(s.office.name, "Novo");
});

test("login com e-mail DIFERENTE não herda nome, preferências nem escritório", () => {
  // Sessão anterior rica: nome, preferências e escritório (admin).
  let s = applySignUp(defaultSession(), { name: "Ana Lima", email: "ana@ex.com" });
  s = applyAutonomo(s, { practiceArea: "Cível", digest: "weekly" });
  s = applySignIn(s, { email: "ana@ex.com" }); // reidentifica como Ana
  s = applyCreateOffice(s, { name: "Escritório Ana" });
  assert.equal(s.office.name, "Escritório Ana");

  // Agora entra OUTRA pessoa (e-mail diferente): começa limpo.
  const other = applySignIn(s, { email: "bruno@ex.com", name: "Bruno" });
  assert.equal(other.user.email, "bruno@ex.com");
  assert.equal(other.user.name, "Bruno");
  assert.notEqual(other.user.name, "Ana Lima");
  assert.equal(other.office, null);
  assert.equal(other.membership, null);
  assert.equal(other.profile, null);
  assert.deepEqual(other.preferences, {});
});

test("login com o MESMO e-mail preserva nome, preferências e escritório", () => {
  let s = applySignUp(defaultSession(), { name: "Ana Lima", email: "ana@ex.com" });
  s = applyAutonomo(s, { practiceArea: "Cível" });
  s = applyCreateOffice(s, { name: "Escritório Ana" });
  const again = applySignIn(s, { email: "ANA@ex.com", name: "Nome Ignorado" }); // case-insensitive
  assert.equal(again.user.name, "Ana Lima");
  assert.equal(again.preferences.practiceArea, "Cível");
  assert.equal(again.office.name, "Escritório Ana");
});

test("restauração após atualizar a página: round-trip JSON preserva a sessão", () => {
  let s = applySignUp(defaultSession(), { name: "Ana Lima", email: "ana@ex.com" });
  s = applyCreateOffice(s, { name: "Escritório Ana" });
  const restored = JSON.parse(JSON.stringify(s)); // simula localStorage
  assert.equal(isValidSession(restored), true);
  assert.deepEqual(restored, s);
  assert.equal(restored.user.name, "Ana Lima");
  assert.equal(restored.office.name, "Escritório Ana");
  assert.equal("password" in (restored.user || {}), false);
});

test("restauração rejeita versão incompatível (evita estado corrompido)", () => {
  const s = applySignUp(defaultSession(), { name: "Ana", email: "a@ex.com" });
  const stale = { ...s, version: SESSION_VERSION + 1 };
  assert.equal(isValidSession(stale), false);
});

// --- Validação completa da sessão restaurada (dados corrompidos) ---
test("isValidSession rejeita permissões e vínculos corrompidos", () => {
  const base = applyCreateOffice(applySignUp(defaultSession(), { name: "Ana", email: "a@ex.com" }), { name: "Esc" });
  assert.equal(isValidSession(base), true);
  // permissão desconhecida
  assert.equal(isValidSession({ ...base, membership: { ...base.membership, permissions: ["deadline.hack"] } }), false);
  // permissions vazio
  assert.equal(isValidSession({ ...base, membership: { ...base.membership, permissions: [] } }), false);
  // vínculo aponta para escritório inexistente/divergente
  assert.equal(isValidSession({ ...base, membership: { ...base.membership, officeId: "outro" } }), false);
  // vínculo com userId divergente do usuário
  assert.equal(isValidSession({ ...base, membership: { ...base.membership, userId: "u_x" } }), false);
  // visibility inválida
  assert.equal(isValidSession({ ...base, membership: { ...base.membership, visibility: "qualquer" } }), false);
  // perfil desconhecido
  assert.equal(isValidSession({ ...base, profile: "chefe" }), false);
  // usuário sem email
  assert.equal(isValidSession({ ...base, user: { id: "u1", name: "Ana" } }), false);
});

// --- Etapa 5: fonte única do vínculo na sessão (sair limpa a sessão) ---
import { applyLeaveOffice } from "../src/lib/session.mjs";

test("applyLeaveOffice encerra o vínculo na sessão e volta ao autônomo", () => {
  const s = applyCreateOffice(applySignUp(defaultSession(), { name: "Ana", email: "a@ex.com" }), { name: "Escritório A" });
  assert.ok(s.office);
  const left = applyLeaveOffice(s);
  assert.equal(left.office, null);
  assert.equal(left.membership, null);
  assert.equal(left.profile, "autonomo");
  // Após sair, a sessão não bloqueia criar outro (não há office na sessão).
  const created = applyCreateOffice(left, { name: "Escritório B" });
  assert.equal(created.office.name, "Escritório B");
});

test("saída → login com mesmo e-mail não restaura o escritório antigo na sessão", () => {
  const s = applyCreateOffice(applySignUp(defaultSession(), { name: "Ana", email: "a@ex.com" }), { name: "Escritório A" });
  const left = applyLeaveOffice(s);
  const back = applySignIn(left, { email: "a@ex.com" }); // mesmo usuário
  assert.equal(back.office, null); // não restaura vínculo encerrado
});
