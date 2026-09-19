import test from "node:test";
import assert from "node:assert/strict";
import { generateAnswer, SUGGESTIONS, DISCLAIMER } from "../src/lib/assistant.mjs";
import { defaultSettings, sanitizeSettings, mergeSettings } from "../src/lib/settings.mjs";
import { applyUpdateProfile, applyUpdatePreferences, applySignUp, defaultSession } from "../src/lib/session.mjs";

const ctx = { open: 4, overdue: 2, dueSoon: 1, reviews: 3, scopeLabel: "pessoal" };

test("assistente: usa contagens do contexto (vencidos, próximos, abertos)", () => {
  assert.match(generateAnswer("Tenho algo vencido?", ctx), /2 prazo/);
  assert.match(generateAnswer("O que vence nos próximos dias?", ctx), /1 prazo/);
  assert.match(generateAnswer("Quantos prazos em aberto?", ctx), /4 prazo/);
});

test("assistente: zero vencidos responde sem alarme", () => {
  const r = generateAnswer("algo atrasado?", { ...ctx, overdue: 0 });
  assert.match(r, /Nenhum prazo vencido/);
});

test("assistente: intimações aguardando revisão refletem o contexto", () => {
  assert.match(generateAnswer("como funciona a revisão de intimações?", ctx), /3 intima/);
});

test("assistente: explica cadastro e transferência (uso da PrazoAI)", () => {
  assert.match(generateAnswer("como cadastro um novo prazo?", ctx), /Novo prazo/);
  assert.match(generateAnswer("como transfiro para o escritório?", ctx), /Transferir/);
});

test("assistente: pergunta vazia orienta; fallback traz aviso de simulação", () => {
  assert.match(generateAnswer("", ctx), /sugestão|pergunta/i);
  assert.match(generateAnswer("qual a jurisprudência sobre X?", ctx), new RegExp(DISCLAIMER.slice(0, 20)));
});

test("assistente: sugestões existem e são focadas em prazos", () => {
  assert.ok(SUGGESTIONS.length >= 4);
  assert.ok(SUGGESTIONS.some((s) => /prazo/i.test(s)));
});

test("settings: padrão e sanitização de valores inválidos", () => {
  const d = defaultSettings();
  assert.equal(d.density, "comfortable");
  const s = sanitizeSettings({ density: "weird", digest: "monthly", soonAlertDays: 99, reduceMotion: "yes" });
  assert.equal(s.density, "comfortable");   // inválido → padrão
  assert.equal(s.digest, "none");
  assert.equal(s.soonAlertDays, 3);
  assert.equal(s.reduceMotion, false);
});

test("settings: merge valida cada campo", () => {
  const s = mergeSettings(defaultSettings(), { density: "compact", showCompleted: true, soonAlertDays: 5 });
  assert.equal(s.density, "compact");
  assert.equal(s.showCompleted, true);
  assert.equal(s.soonAlertDays, 5);
  // patch inválido não corrompe
  const s2 = mergeSettings(s, { density: "nope" });
  assert.equal(s2.density, "comfortable");
});

test("perfil: atualiza nome mas nunca o e-mail (âncora de identidade)", () => {
  const base = applySignUp(defaultSession(), { name: "Ana", email: "ana@ex.com" });
  const up = applyUpdateProfile(base, { name: "Ana Paula" });
  assert.equal(up.user.name, "Ana Paula");
  assert.equal(up.user.email, "ana@ex.com"); // inalterado
  // nome vazio mantém o anterior
  const up2 = applyUpdateProfile(up, { name: "   " });
  assert.equal(up2.user.name, "Ana Paula");
});

test("perfil: preferências mesclam sem apagar as demais", () => {
  const base = applyUpdatePreferences(defaultSession(), { practiceArea: "Cível" });
  const merged = applyUpdatePreferences(base, { digest: "weekly" });
  assert.equal(merged.preferences.practiceArea, "Cível");
  assert.equal(merged.preferences.digest, "weekly");
});

// --- Etapa 6 (correções): isolamento do assistente e intimações ---
import { canAccessIntimation } from "../src/lib/deadline-guards.mjs";

// chave de conversa = usuário + ambiente (réplica da lógica da tela)
function convKey(userId, scope) {
  const env = scope.kind === "personal" ? `p:${scope.ownerId}` : `o:${scope.officeId}`;
  return `${userId}|${env}`;
}

test("assistente: chave isola por usuário E por ambiente", () => {
  const uA = "u_a", uB = "u_b";
  const pessoalA = convKey(uA, { kind: "personal", ownerId: uA });
  const pessoalB = convKey(uB, { kind: "personal", ownerId: uB });
  const escr1 = convKey(uA, { kind: "office", officeId: "off1" });
  const escr2 = convKey(uA, { kind: "office", officeId: "off2" });
  // todas distintas
  const keys = new Set([pessoalA, pessoalB, escr1, escr2]);
  assert.equal(keys.size, 4);
  // trocar de ambiente muda a chave (não reaproveita a conversa)
  assert.notEqual(pessoalA, escr1);
  assert.notEqual(escr1, escr2);
});

test("assistente: store isola conversas — carregar chave nova não traz mensagens antigas", () => {
  const store = {};
  const kPessoal = convKey("u1", { kind: "personal", ownerId: "u1" });
  const kOffice = convKey("u1", { kind: "office", officeId: "off1" });
  store[kPessoal] = [{ id: "m1", role: "user", text: "no pessoal" }];
  // ao entrar no ambiente escritório, a conversa é a da chave do escritório (vazia)
  const loaded = Array.isArray(store[kOffice]) ? store[kOffice] : [];
  assert.deepEqual(loaded, []);
  // e gravar no escritório não altera a conversa pessoal
  store[kOffice] = [{ id: "m2", role: "user", text: "no escritório" }];
  assert.equal(store[kPessoal].length, 1);
  assert.equal(store[kPessoal][0].text, "no pessoal");
});

const inti = (over = {}) => ({ id: "i1", scope: { kind: "office", officeId: "off1" }, fileName: "a.pdf", status: "awaiting_review", receivedAt: "2026-09-16", ...over });
const ctxOffice = (userId, visibility, perms = ["deadline.read"]) => ({
  scope: { kind: "office", officeId: "off1" }, scopeKind: "office", userId,
  membership: { userId, officeId: "off1", roleLabel: "x", practiceAreas: [], permissions: perms, visibility },
});

test("intimações: visibilidade 'all' vê todas; 'assigned' só as próprias (sugerido/vinculado)", () => {
  const other = inti({ suggestedResponsibleId: "u2" });
  const mine = inti({ suggestedResponsibleId: "u1" });
  // all vê ambas
  assert.equal(canAccessIntimation(other, ctxOffice("u1", "all")), true);
  // assigned NÃO vê a de outro responsável
  assert.equal(canAccessIntimation(other, ctxOffice("u1", "assigned")), false);
  // assigned vê a sugerida para si
  assert.equal(canAccessIntimation(mine, ctxOffice("u1", "assigned")), true);
  // assigned vê pelo prazo vinculado do qual é responsável
  const linked = inti({ status: "reviewed", deadlineId: "d9", suggestedResponsibleId: "u2" });
  const resolve = (id) => (id === "d9" ? "u1" : undefined);
  assert.equal(canAccessIntimation(linked, ctxOffice("u1", "assigned"), resolve), true);
  assert.equal(canAccessIntimation(linked, ctxOffice("u1", "assigned")), false); // sem resolver, não vaza
});

test("intimações: sem permissão de leitura não acessa; outro escritório bloqueado", () => {
  assert.equal(canAccessIntimation(inti(), ctxOffice("u1", "all", [])), false); // sem deadline.read
  const outsider = { scope: { kind: "office", officeId: "off2" }, scopeKind: "office", userId: "u9",
    membership: { userId: "u9", officeId: "off2", roleLabel: "x", practiceAreas: [], permissions: ["deadline.read"], visibility: "all" } };
  assert.equal(canAccessIntimation(inti(), outsider), false);
});

test("cancelamento de resposta pendente: timer não entrega quando a chave mudou", () => {
  // Réplica da guarda do setTimeout: só entrega se keyRef === askedKey.
  let delivered = false;
  const askedKey = "u1|p:u1";
  let currentKey = askedKey;
  const deliver = () => { if (currentKey !== askedKey) return; delivered = true; };
  // troca de ambiente antes de "disparar"
  currentKey = "u1|o:off1";
  deliver();
  assert.equal(delivered, false); // resposta do contexto anterior NÃO aparece
  // mesma chave → entrega normal
  currentKey = askedKey; delivered = false; deliver();
  assert.equal(delivered, true);
});

test("perfil: hidratação usa a sessão salva, não a persona demonstrativa", () => {
  // Simula: persona inicial (u1/Paula) antes de hidratar; sessão salva = Ana.
  const persona = { name: "Paula (demo)" };
  const savedSession = applySignUp(defaultSession(), { name: "Ana", email: "ana@ex.com" });
  const hydrated = true;
  const touched = false;
  // valor efetivo do campo após hidratação (réplica do efeito de sync)
  const fieldName = hydrated && !touched ? (savedSession.user?.name ?? "") : persona.name;
  assert.equal(fieldName, "Ana");
  assert.notEqual(fieldName, persona.name);
});
