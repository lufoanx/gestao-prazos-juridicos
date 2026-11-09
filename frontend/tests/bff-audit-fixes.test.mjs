// Auditoria 6.1 — (1) login pendente × logout em outra aba; (2) corpo da resposta de refresh.
// Testes UNITÁRIOS com dublê do backend (a integração real e o E2E cobrem os mesmos casos).
import test from "node:test";
import assert from "node:assert/strict";
import { loadBffConfig } from "../src/server/bff/config.mjs";
import { createMemorySessionStore } from "../src/server/bff/session-store.mjs";
import { createBff, validTokenPair } from "../src/server/bff/manager.mjs";
import { createFakeBackend, deferred, tok } from "./helpers/fake-backend.mjs";

const ORIGIN = "http://localhost:3000";
const ENV = { PRAZOAI_APP_ENV: "test", PRAZOAI_APP_ORIGIN: ORIGIN, PRAZOAI_COOKIE_INSECURE_LOCAL: "true" };

function setup({ env = {}, wrap, maxResponseBytes } = {}) {
  let t = 1_000_000;
  const clock = { now: () => t, advance: (ms) => { t += ms; } };
  const config = loadBffConfig({ ...ENV, ...env });
  const store = createMemorySessionStore(config.session, clock.now);
  const backend = createFakeBackend();
  const fetchImpl = (u, i) => (wrap ? wrap(backend.fetch, u, i) : backend.fetch(u, i));
  const bff = createBff({ config, store, fetchImpl, now: clock.now, logger: { info() {} }, maxResponseBytes });
  return { bff, store, backend, clock };
}

function req(method, path, { body, cookie } = {}) {
  const h = new Headers({ "x-prazoai-csrf": "1", origin: ORIGIN });
  if (cookie) h.set("cookie", cookie);
  if (body) h.set("content-type", "application/json");
  return new Request(`${ORIGIN}${path}`, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
}
const creds = { email: "ana@exemplo.com", password: "Senha-123" };
const cookieOf = (r) => r.headers.get("set-cookie")?.split(";")[0];
const tick = () => new Promise((r) => setImmediate(r));

function gatedLogin() {
  const gate = deferred();
  let hold = true;
  return {
    gate,
    release() { hold = false; gate.resolve(); },
    wrap: async (fetch, u, i) => { if (hold && String(u).endsWith("/auth/login")) await gate.promise; return fetch(u, i); },
  };
}

// ======================================================================
// 1. Login × logout entre abas (coordenação no servidor)
// ======================================================================
test("login pendente + logout em outra aba com o cookie anterior → não instala sessão", async () => {
  const g = gatedLogin();
  g.release();                                                         // 1º login livre
  const env = setup({ wrap: g.wrap });
  const first = await env.bff.login(req("POST", "/bff/auth/login", { body: creds }));
  const cookie = cookieOf(first);
  const g2 = gatedLogin();
  const env2 = { ...env, bff: createBff({ config: loadBffConfig(ENV), store: env.store, fetchImpl: (u, i) => g2.wrap(env.backend.fetch, u, i), now: env.clock.now, logger: { info() {} } }) };
  const pending = env2.bff.login(req("POST", "/bff/auth/login", { cookie, body: creds }));   // aba A
  await tick();
  const out = await env2.bff.logout(req("POST", "/bff/auth/logout", { cookie }));            // aba B
  assert.equal(out.status, 204);
  g2.release();
  const late = await pending;
  assert.equal(late.status, 409);
  assert.equal((await late.json()).error.code, "login_cancelled");
  assert.match(late.headers.get("set-cookie"), /Max-Age=0/);                              // limpa, não instala
  assert.equal(env.store.size, 0);
  const newAccess = env.backend.current.access;
  assert.ok(env.backend.calls.some((c) => c.path === "/auth/logout" && c.headers.authorization === `Bearer ${newAccess}`));
});

test("login que chega ao servidor DEPOIS do logout com o cookie antigo é recusado sem ir ao backend", async () => {
  const env = setup();
  const cookie = cookieOf(await env.bff.login(req("POST", "/bff/auth/login", { body: creds })));
  await env.bff.logout(req("POST", "/bff/auth/logout", { cookie }));
  const before = env.backend.calls.length;
  const late = await env.bff.login(req("POST", "/bff/auth/login", { cookie, body: creds }));
  assert.equal(late.status, 409);
  assert.equal(env.backend.calls.length, before);
  assert.equal(env.store.size, 0);
});

test("login explícito depois do logout (sem o cookie antigo) funciona", async () => {
  const env = setup();
  const cookie = cookieOf(await env.bff.login(req("POST", "/bff/auth/login", { body: creds })));
  await env.bff.logout(req("POST", "/bff/auth/logout", { cookie }));
  const again = await env.bff.login(req("POST", "/bff/auth/login", { body: creds }));
  assert.equal(again.status, 200);
  assert.equal(env.store.size, 1);
});

test("dois logins com o mesmo cookie: o mais antigo é cancelado; fica uma sessão", async () => {
  const g = gatedLogin();
  g.release();
  const env = setup({ wrap: g.wrap });
  const cookie = cookieOf(await env.bff.login(req("POST", "/bff/auth/login", { body: creds })));
  const g2 = gatedLogin();
  const bff2 = createBff({ config: loadBffConfig(ENV), store: env.store, fetchImpl: (u, i) => g2.wrap(env.backend.fetch, u, i), now: env.clock.now, logger: { info() {} } });
  const older = bff2.login(req("POST", "/bff/auth/login", { cookie, body: creds }));
  await tick();
  const newer = env.bff.login(req("POST", "/bff/auth/login", { cookie, body: creds }));      // sem pausa
  const rNewer = await newer;
  g2.release();
  const rOlder = await older;
  assert.equal(rNewer.status, 200);
  assert.equal(rOlder.status, 409);
  assert.equal(env.store.size, 1);
});

test("primeiro login pendente (sem cookie) + logout sem sessão: o login conclui (comportamento definido)", async () => {
  const g = gatedLogin();
  const env = setup({ wrap: g.wrap });
  const pending = env.bff.login(req("POST", "/bff/auth/login", { body: creds }));
  await tick();
  assert.equal((await env.bff.logout(req("POST", "/bff/auth/logout"))).status, 204);
  g.release();
  const r = await pending;
  assert.equal(r.status, 200);
  assert.equal(env.store.size, 1);
});

test("login com credenciais erradas preserva a sessão anterior", async () => {
  const env = setup();
  const cookie = cookieOf(await env.bff.login(req("POST", "/bff/auth/login", { body: creds })));
  env.backend.loginStatus = 401;
  assert.equal((await env.bff.login(req("POST", "/bff/auth/login", { cookie, body: creds }))).status, 401);
  const s = await env.bff.session(req("GET", "/bff/session", { cookie }));
  assert.equal((await s.json()).authenticated, true);
});

test("registro de logouts é limitado (teto e TTL) e guarda só o hash do id", () => {
  let t = 0;
  const store = createMemorySessionStore({ maxSessions: 3, idleSeconds: 60, maxAgeSeconds: 300, sweepIntervalSeconds: 1,
    logoutMemorySeconds: 120 }, () => t);
  const ids = ["A".repeat(43), "B".repeat(43), "C".repeat(43), "D".repeat(43)];
  for (const id of ids) store.markLoggedOut(id);
  assert.equal(store.loggedOutSize, 3);                                // teto
  assert.equal(store.wasLoggedOut(ids[0]), false);                     // mais antigo descartado
  assert.equal(store.wasLoggedOut(ids[3]), true);
  t += 120_000;
  assert.equal(store.wasLoggedOut(ids[3]), false);                     // TTL
  assert.equal(store.loggedOutSize, 0);
});

// ======================================================================
// 2. Corpo da resposta de refresh
// ======================================================================
const enc = new TextEncoder();
function brokenBody(prefix) {
  return new ReadableStream({ start(c) { c.enqueue(enc.encode(prefix)); c.error(new Error("conexão caiu")); } });
}

async function refreshScenario(transform) {
  const env = setup({ wrap: async (fetch, u, i) => {
    const res = await fetch(u, i);
    if (String(u).endsWith("/auth/refresh") && res.status === 200) return transform(res);
    return res;
  } });
  const cookie = cookieOf(await env.bff.login(req("POST", "/bff/auth/login", { body: creds })));
  const oldRefresh = env.backend.current.refresh;
  env.clock.advance(890_000);
  const first = await env.bff.session(req("GET", "/bff/session", { cookie }));
  const second = await env.bff.proxy(req("GET", "/bff/api/users/me", { cookie }), "/users/me");
  const refreshes = env.backend.calls.filter((c) => c.path === "/auth/refresh");
  return { env, first, second, refreshes, oldRefresh };
}

for (const [name, transform] of [
  ["corpo interrompido", async () => new Response(brokenBody('{"accessToken":"'), { status: 200, headers: { "content-type": "application/json" } })],
  ["JSON inválido", async () => new Response("{nao-e-json", { status: 200, headers: { "content-type": "application/json" } })],
  ["200 incompleto", async (res) => { const j = await res.json(); delete j.refreshToken; return new Response(JSON.stringify(j), { status: 200 }); }],
  ["expiresIn inválido", async (res) => { const j = await res.json(); j.expiresIn = "900"; return new Response(JSON.stringify(j), { status: 200 }); }],
  ["corpo vazio", async () => new Response(null, { status: 200 })],
]) {
  test(`refresh com ${name}: incerto → sessão invalidada e refresh antigo NÃO reenviado`, async () => {
    const { env, first, second, refreshes, oldRefresh } = await refreshScenario(transform);
    assert.equal(first.status, 401);
    assert.equal((await first.json()).error.code, "session_refresh_uncertain");
    assert.match(first.headers.get("set-cookie"), /Max-Age=0/);
    assert.equal(second.status, 401);
    assert.equal(refreshes.length, 1);                                       // nenhuma nova renovação
    assert.equal(refreshes.filter((c) => c.body.refreshToken === oldRefresh).length, 1);
    assert.equal(env.store.size, 0);
    assert.equal(env.backend.revoked, false);                                // reutilização não foi provocada
  });
}

test("indisponibilidade comprovadamente anterior ao envio continua preservando a sessão", async () => {
  const env = setup();
  const cookie = cookieOf(await env.bff.login(req("POST", "/bff/auth/login", { body: creds })));
  env.clock.advance(890_000);
  env.backend.failRefresh = "refused";
  const r = await env.bff.proxy(req("GET", "/bff/api/users/me", { cookie }), "/users/me");
  assert.equal(r.status, 503);
  assert.equal(env.store.size, 1);
});

test("leitura do corpo: teto de bytes aplicado em fluxo (sem carregar tudo)", async () => {
  let pulled = 0;
  let cancelled = false;
  const endless = new ReadableStream({
    pull(c) { pulled += 1; c.enqueue(enc.encode("x".repeat(1024))); },
    cancel() { cancelled = true; },
  });
  const env = setup({ maxResponseBytes: 8 * 1024, wrap: async (fetch, u, i) =>
    String(u).endsWith("/users/me") ? new Response(endless, { status: 200 }) : fetch(u, i) });
  const cookie = cookieOf(await env.bff.login(req("POST", "/bff/auth/login", { body: creds })));
  const r = await env.bff.proxy(req("GET", "/bff/api/users/me", { cookie }), "/users/me");
  assert.equal(r.status, 503);                                             // GET incerto → indisponível
  assert.equal(cancelled, true);
  assert.ok(pulled <= 10, `blocos lidos: ${pulled}`);
});

test("leitura do corpo: o timeout também vale durante a leitura", async () => {
  const stuck = new ReadableStream({ start(c) { c.enqueue(enc.encode('{"id":')); } });   // nunca termina
  const env = setup({ env: { PRAZOAI_BFF_TIMEOUT_MS: "150" }, wrap: async (fetch, u, i) =>
    String(u).endsWith("/auth/refresh") ? new Response(stuck, { status: 200 }) : fetch(u, i) });
  const cookie = cookieOf(await env.bff.login(req("POST", "/bff/auth/login", { body: creds })));
  env.clock.advance(890_000);
  const started = Date.now();
  const r = await env.bff.session(req("GET", "/bff/session", { cookie }));
  assert.ok(Date.now() - started < 3000);
  assert.equal(r.status, 401);
  assert.equal((await r.json()).error.code, "session_refresh_uncertain");
});

test("erro HTTP com corpo ilegível continua sendo resposta (não incerto)", async () => {
  const env = setup({ wrap: async (fetch, u, i) =>
    String(u).endsWith("/users/me") ? new Response("<html>bad gateway</html>", { status: 502 }) : fetch(u, i) });
  const cookie = cookieOf(await env.bff.login(req("POST", "/bff/auth/login", { body: creds })));
  const r = await env.bff.proxy(req("GET", "/bff/api/users/me", { cookie }), "/users/me");
  assert.equal(r.status, 503);
  assert.equal(env.store.size, 1);
});

test("validação do par de tokens", () => {
  const ok = { accessToken: tok("a", 1), refreshToken: tok("r", 1), expiresIn: 900 };
  assert.equal(validTokenPair(ok), true);
  for (const bad of [null, {}, { ...ok, accessToken: "" }, { ...ok, refreshToken: 1 }, { ...ok, expiresIn: 0 },
                     { ...ok, expiresIn: 1.5 }, { ...ok, expiresIn: 999999 }, { ...ok, accessToken: "curto" }]) {
    assert.equal(validTokenPair(bad), false, JSON.stringify(bad));
  }
});
