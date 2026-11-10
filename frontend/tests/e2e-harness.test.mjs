// Infraestrutura simulada do E2E: o proxy de borda é a ÚNICA fonte do cabeçalho confiável.
import test from "node:test";
import assert from "node:assert/strict";
import { IDENTITY_COOKIE, TRUSTED_HEADER, edgeHeaders, splitIdentity } from "../e2e/edge-proxy.mjs";

test("borda: identidade do harness vira o cabeçalho confiável e some dos cookies", () => {
  const h = edgeHeaders({ host: "localhost:3100", origin: "http://localhost:3100", cookie: `prazoai_sid_abcdefghij=x; ${IDENTITY_COOKIE}=203.0.113.7; prazoai_bid=y` });
  assert.equal(h[TRUSTED_HEADER], "203.0.113.7");
  assert.equal(h.cookie, "prazoai_sid_abcdefghij=x; prazoai_bid=y");
  assert.equal(h.origin, "http://localhost:3100");                         // Origin preservado
  assert.equal(edgeHeaders({ host: "localhost:3100" }, "localhost:3101").host, "localhost:3101");
});

test("borda: cabeçalhos enviados pela página não decidem o IP", () => {
  const forged = { "x-forwarded-for": "6.6.6.6", "x-real-ip": "6.6.6.6", forwarded: "for=6.6.6.6", [TRUSTED_HEADER]: "203.0.113.200",
    "x-prazoai-client-ip": "6.6.6.6", "x-prazoai-proxy-secret": "forjado" };
  let h = edgeHeaders({ ...forged, cookie: `${IDENTITY_COOKIE}=198.51.100.9` });
  assert.equal(h[TRUSTED_HEADER], "198.51.100.9");
  for (const k of ["x-forwarded-for", "x-real-ip", "forwarded", "x-prazoai-client-ip", "x-prazoai-proxy-secret"]) assert.equal(h[k], undefined, k);
  h = edgeHeaders({ ...forged });                                            // sem identidade: nada encaminhado
  assert.equal(h[TRUSTED_HEADER], undefined);
});

test("borda: só endereços de documentação são aceitos como identidade", () => {
  for (const bad of ["10.0.0.1", "8.8.8.8", "203.0.113.0", "203.0.113.255", "203.0.113.7, 1.1.1.1", "198.51.100", "abc"]) {
    assert.equal(splitIdentity(`${IDENTITY_COOKIE}=${bad}`).ip, null, bad);
  }
  assert.equal(splitIdentity(`${IDENTITY_COOKIE}=203.0.113.254`).ip, "203.0.113.254");
});
