// Doc 26 — decisão de interface da entrada no ambiente do escritório (modos demo e integrado).
import test from "node:test";
import assert from "node:assert/strict";
import { OFFICE_ENTRY_TEXT, officeEntryState } from "../src/lib/office-entry.mjs";

test("vínculo ainda não carregado nunca é apresentado como 'sem escritório'", () => {
  for (const status of ["idle", "loading"]) {
    assert.equal(officeEntryState({ status, hasOffice: false, scope: "personal" }), "loading");
  }
  for (const status of ["error", "unavailable"]) {
    assert.equal(officeEntryState({ status, hasOffice: false, scope: "personal" }), "error");
    assert.equal(officeEntryState({ status, hasOffice: true, scope: "office" }), "error");
  }
});

test("sem vínculo → caminhos de criação/ingresso; com vínculo no pessoal → troca explícita; no escritório → conteúdo", () => {
  assert.equal(officeEntryState({ status: "ready", hasOffice: false, scope: "personal" }), "no-office");
  assert.equal(officeEntryState({ status: "ready", hasOffice: false, scope: "office" }), "no-office");   // preferência antiga não concede
  assert.equal(officeEntryState({ status: "ready", hasOffice: true, scope: "personal" }), "personal");
  assert.equal(officeEntryState({ status: "ready", hasOffice: true, scope: "office" }), "office");
  assert.equal(officeEntryState({ hasOffice: true, scope: "office" }), "office");                      // demo: sem status remoto
});

test("textos explicam o motivo e nomeiam as ações existentes (sem prometer transferência)", () => {
  assert.match(OFFICE_ENTRY_TEXT.noOffice, /não pertence a um escritório/);
  assert.equal(OFFICE_ENTRY_TEXT.createAction, "Criar escritório");
  assert.equal(OFFICE_ENTRY_TEXT.joinAction, "Solicitar ingresso com código");
  assert.match(OFFICE_ENTRY_TEXT.personal, /ambiente pessoal/);
  assert.match(OFFICE_ENTRY_TEXT.personalHow, /nenhum dado é transferido/);
  assert.ok(Object.isFrozen(OFFICE_ENTRY_TEXT));
});
