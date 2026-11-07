// Issue #5 — visibilidade da intimação vinculada para membros com visibility="assigned".
// O responsável pelo prazo deve ver a intimação vinculada a ele, sem ampliar o acesso
// de mais ninguém. O resolver é único (makeResponsibleResolver) e usado por todos os
// consumidores (dashboard, lista, revisão, assistente, processador e operações).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { canAccessIntimation, canWriteIntimation, makeResponsibleResolver } from "../src/lib/deadline-guards.mjs";
import { opConfirmIntimationReview, opRemoveIntimation, opRetryIntimation } from "../src/lib/data-ops.mjs";

const OFF1 = { kind: "office", officeId: "off1" };
const OFF2 = { kind: "office", officeId: "off2" };
const ctxOffice = (userId, visibility, perms = ["deadline.read", "deadline.create"], officeId = "off1") => ({
  scope: { kind: "office", officeId }, scopeKind: "office", userId,
  membership: { userId, officeId, roleLabel: "x", practiceAreas: [], permissions: perms, visibility },
});
const deadline = (over = {}) => ({ id: "d1", scope: OFF1, responsibleId: "u2", title: "Prazo", ...over });
const inti = (over = {}) => ({
  id: "i1", scope: OFF1, fileName: "a.pdf", status: "reviewed", receivedAt: "2026-09-16",
  createdBy: "u1", suggestedResponsibleId: "u1", deadlineId: "d1", ...over,
});

// ---------- Resolver ----------
test("#5 resolver: retorna o responsável do prazo vinculado", () => {
  const resolve = makeResponsibleResolver([deadline()], OFF1);
  assert.equal(resolve("d1"), "u2");
});

test("#5 resolver: prazo inexistente, id inválido ou lista ausente → undefined, sem erro", () => {
  const resolve = makeResponsibleResolver([deadline()], OFF1);
  assert.equal(resolve("nao-existe"), undefined);
  assert.equal(resolve(undefined), undefined);
  assert.equal(resolve(42), undefined);
  assert.doesNotThrow(() => makeResponsibleResolver(undefined, OFF1)("d1"));
  assert.equal(makeResponsibleResolver(null)("d1"), undefined);
  assert.equal(makeResponsibleResolver([null, {}, { id: "d1" }], OFF1)("d1"), undefined);
});

test("#5 resolver: prazo de outro ambiente não é considerado", () => {
  const resolve = makeResponsibleResolver([deadline({ scope: OFF2 })], OFF1);
  assert.equal(resolve("d1"), undefined);
});

// ---------- Leitura ----------
test("#5 responsável assigned vê o prazo e a intimação vinculada", () => {
  const deadlines = [deadline({ responsibleId: "u2" })];
  const resolve = makeResponsibleResolver(deadlines, OFF1);
  assert.equal(canAccessIntimation(inti(), ctxOffice("u2", "assigned"), resolve), true);
});

test("#5 outro membro assigned não vê a intimação vinculada", () => {
  const resolve = makeResponsibleResolver([deadline({ responsibleId: "u2" })], OFF1);
  assert.equal(canAccessIntimation(inti(), ctxOffice("u3", "assigned"), resolve), false);
});

test("#5 prazo inexistente não libera acesso", () => {
  const resolve = makeResponsibleResolver([deadline({ id: "outro" })], OFF1);
  assert.equal(canAccessIntimation(inti({ deadlineId: "d1" }), ctxOffice("u2", "assigned"), resolve), false);
});

test("#5 usuário sem deadline.read continua bloqueado mesmo sendo responsável", () => {
  const resolve = makeResponsibleResolver([deadline({ responsibleId: "u2" })], OFF1);
  assert.equal(canAccessIntimation(inti(), ctxOffice("u2", "assigned", []), resolve), false);
  assert.equal(canAccessIntimation(inti(), ctxOffice("u2", "assigned", ["deadline.create"]), resolve), false);
});

test("#5 isolamento: outro escritório e prazo homônimo de outro ambiente não liberam", () => {
  const resolve = makeResponsibleResolver([deadline({ responsibleId: "u2" })], OFF1);
  assert.equal(canAccessIntimation(inti(), ctxOffice("u2", "all", ["deadline.read"], "off2"), resolve), false);
  const cross = makeResponsibleResolver([deadline({ scope: OFF2, responsibleId: "u2" })], OFF1);
  assert.equal(canAccessIntimation(inti(), ctxOffice("u2", "assigned"), cross), false);
});

test("#5 demais regras preservadas: autor, sugerido e visibility=all", () => {
  const resolve = makeResponsibleResolver([deadline({ responsibleId: "u2" })], OFF1);
  const processing = inti({ status: "processing", deadlineId: undefined, suggestedResponsibleId: undefined, createdBy: "u4" });
  assert.equal(canAccessIntimation(processing, ctxOffice("u4", "assigned"), resolve), true);  // autor
  assert.equal(canAccessIntimation(processing, ctxOffice("u2", "assigned"), resolve), false); // nada liga u2
  const suggested = inti({ status: "awaiting_review", deadlineId: undefined, suggestedResponsibleId: "u5" });
  assert.equal(canAccessIntimation(suggested, ctxOffice("u5", "assigned"), resolve), true);   // sugerido
  assert.equal(canAccessIntimation(inti(), ctxOffice("u9", "all"), resolve), true);          // all vê tudo
});

// ---------- Escrita: mesmo contrato, sem duplicidade ----------
test("#5 canWriteIntimation usa o mesmo resolver e ainda exige a permissão", () => {
  const resolve = makeResponsibleResolver([deadline({ responsibleId: "u2" })], OFF1);
  assert.equal(canWriteIntimation(inti(), ctxOffice("u2", "assigned"), "deadline.create", resolve), true);
  assert.equal(canWriteIntimation(inti(), ctxOffice("u2", "assigned", ["deadline.read"]), "deadline.create", resolve), false);
  assert.equal(canWriteIntimation(inti(), ctxOffice("u3", "assigned"), "deadline.create", resolve), false);
});

const deps = { newId: (p) => `${p}_x`, today: "2026-09-16" };
const stateWith = () => ({
  version: 1, deadlines: [deadline({ responsibleId: "u2" })], comments: [], attachments: [], audit: [],
  notifications: [], removedAttachmentIds: [], intimations: [inti()], removedIntimationIds: [],
});
const seeds = { deadlines: [], attachments: [], intimations: [], notifications: [] };
const review = {
  title: "Outro", caseNumber: "1", court: "T", practiceArea: "Cível", responsibleId: "u2",
  priority: "normal", startDate: "2026-09-16", dueDate: "2026-09-26", countingMode: "business", duration: 5,
};

test("#5 operações: responsável vinculado não duplica prazo nem remove intimação revisada", () => {
  const s = stateWith();
  const res = opConfirmIntimationReview(s, ctxOffice("u2", "assigned"), "i1", review, deps, seeds);
  assert.equal(res.state, s);              // nada muda
  assert.equal(res.state.deadlines.length, 1);
  assert.equal(res.deadlineId, "d1");      // aponta para o prazo existente
  assert.equal(opRemoveIntimation(s, ctxOffice("u2", "assigned"), "i1", deps, seeds), s);
  assert.equal(opRetryIntimation(s, ctxOffice("u2", "assigned"), "i1", deps, seeds), s);
});

test("#5 operações: membro sem vínculo continua bloqueado", () => {
  const s = stateWith();
  const res = opConfirmIntimationReview(s, ctxOffice("u3", "assigned"), "i1", review, deps, seeds);
  assert.equal(res.state, s);
  assert.equal(res.deadlineId, null);
});

// ---------- Contrato: nenhum consumidor esquece o resolver ----------
function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

// Conta argumentos de nível superior de cada chamada (respeita parênteses aninhados).
function findCalls(code) {
  const out = [];
  const re = /\b(canAccessIntimation|canWriteIntimation)\(/g;
  let m;
  while ((m = re.exec(code))) {
    if (/import\s*\{[^}]*$/.test(code.slice(Math.max(0, m.index - 200), m.index))) continue;
    let depth = 1, args = 1, i = re.lastIndex;
    for (; i < code.length && depth > 0; i++) {
      const c = code[i];
      if (c === "(" || c === "[" || c === "{") depth++;
      else if (c === ")" || c === "]" || c === "}") depth--;
      else if (c === "," && depth === 1) args++;
    }
    out.push({ name: m[1], args });
  }
  return out;
}

test("#5 todos os consumidores das guardas de intimação fornecem o resolver", () => {
  const srcDir = new URL("../src", import.meta.url).pathname;
  const files = walk(srcDir).filter((f) => /\.(tsx?|mjs)$/.test(f) && !f.endsWith("deadline-guards.mjs"));
  const consumers = files.filter((f) => /can(Access|Write)Intimation\(/.test(readFileSync(f, "utf8")));
  assert.ok(consumers.length >= 6, `consumidores encontrados: ${consumers.length}`);
  for (const f of consumers) {
    const code = readFileSync(f, "utf8");
    for (const { name, args } of findCalls(code)) {
      const min = name === "canWriteIntimation" ? 4 : 3;
      assert.ok(args >= min, `${f}: ${name} chamado com ${args} argumento(s), sem resolver`);
    }
  }
});
