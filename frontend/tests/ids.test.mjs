import test from "node:test";
import assert from "node:assert/strict";
import { userIdFromEmail, officeIdFor, newId, stableHash } from "../src/lib/ids.mjs";

test("userIdFromEmail é estável e insensível a maiúsculas/espaços", () => {
  assert.equal(userIdFromEmail("ana@ex.com"), userIdFromEmail(" ANA@ex.com "));
  assert.match(userIdFromEmail("ana@ex.com"), /^u_/);
});

test("e-mails diferentes geram ids diferentes (evita mistura de contas)", () => {
  assert.notEqual(userIdFromEmail("ana@ex.com"), userIdFromEmail("bruno@ex.com"));
});

test("officeIdFor depende do dono e do nome", () => {
  const a = officeIdFor("u_ana", "Escritório X");
  assert.equal(a, officeIdFor("u_ana", "escritório x")); // normaliza nome
  assert.notEqual(a, officeIdFor("u_bruno", "Escritório X")); // dono diferente
  assert.notEqual(a, officeIdFor("u_ana", "Escritório Y")); // nome diferente
  assert.match(a, /^office_/);
});

test("newId gera ids únicos com prefixo", () => {
  const ids = new Set(Array.from({ length: 200 }, () => newId("d")));
  assert.equal(ids.size, 200);
  assert.ok([...ids].every((id) => id.startsWith("d_")));
});

test("stableHash é determinístico", () => {
  assert.equal(stableHash("abc"), stableHash("abc"));
  assert.notEqual(stableHash("abc"), stableHash("abd"));
});
