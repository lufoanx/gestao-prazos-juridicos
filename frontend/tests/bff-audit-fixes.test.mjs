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

/** Pote de cookies como o navegador: aplica Set-Cookie (inclusive Max-Age=0) e monta o cabeçalho Cookie. */
function jar() {
  const m = new Map();
  return {
    apply(r) {
      for (const c of r.headers.getSetCookie()) {
        const [nv, ...attrs] = c.split(";");
        const i = nv.indexOf("=");
        const name = nv.slice(0, i).trim();
        if (attrs.some((x) => x.trim() === "Max-Age=0")) m.delete(name);
        else m.set(name, nv.slice(i + 1));
      }
      return this;
    },
    header() { return [...m].map(([n, v]) => `${n}=${v}`).join("; "); },
    sessionNames() { return [...m.keys()].filter((n) => /_sid_[a-z0-9]{10}$/.test(n)); },
  };
}

/** Pausa a PRÓXIMA chamada ao caminho dado (gate determinístico, sem sleeps). */
function pausable(env) {
  const gates = new Map();
  const wrap = async (fetch, u, i) => {
    const path = new URL(u).pathname.replace("/api/v1", "");
    const g = gates.get(path);
    if (g) { gates.delete(path); g.reached.resolve(); await g.go.promise; }
    return fetch(u, i);
  };
  const pause = (path) => { const g = { reached: deferred(), go: deferred() }; gates.set(path, g); return g; };
  return { wrap, pause };
}

function coordSetup(env = {}) {
  const p = pausable();
  const e = setup({ env, wrap: p.wrap });
  return { ...e, pause: p.pause };
}

const loginReq = (j) => req("POST", "/bff/auth/login", { body: creds, cookie: j?.header() || undefined });
const logoutReq = (j) => req("POST", "/bff/auth/logout", { cookie: j.header() || undefined });
const sessionOf = async (env, j) => (await env.bff.session(req("GET", "/bff/session", { cookie: j.header() || undefined }))).json();

// ======================================================================
// 1. Login × logout entre abas — protocolo v3 (coordenação no servidor)
// ======================================================================
test("pausa 1 (resposta do /auth/login): logout em outra aba vence; nada é instalado", async () => {
  const env = coordSetup();
  const j = jar().apply(await env.bff.login(loginReq()));
  const g = env.pause("/auth/login");
  const pending = env.bff.login(loginReq(j));                           // aba A
  await g.reached.promise;
  const out = await env.bff.logout(logoutReq(j));                       // aba B
  j.apply(out);
  g.go.resolve();
  const late = await pending;
  j.apply(late);
  assert.equal(out.status, 204);
  assert.equal(late.status, 409);
  assert.equal((await late.json()).error.code, "login_cancelled");
  assert.equal(env.store.size, 0);
  assert.equal((await sessionOf(env, j)).authenticated, false);
  assert.ok(env.backend.sessions.every((s) => s.revoked));             // inclusive o par recém-emitido
});

test("pausa 2 (revogação da sessão anterior): logout concluído não é revertido (cenário da auditoria)", async () => {
  const env = coordSetup();
  const j = jar().apply(await env.bff.login(loginReq()));
  const g = env.pause("/auth/logout");                                  // revogação feita pelo login
  const pending = env.bff.login(loginReq(j));
  await g.reached.promise;
  const out = await env.bff.logout(logoutReq(j));
  j.apply(out);
  g.go.resolve();
  const late = await pending;
  j.apply(late);
  assert.equal(out.status, 204);
  assert.equal(late.status, 409);
  assert.equal(j.sessionNames().length, 0);                             // nenhum cookie de sessão instalado
  assert.equal(env.store.size, 0);
  assert.equal((await sessionOf(env, j)).authenticated, false);
});

test("pausa 3 (revogação dos tokens da tentativa perdida): resposta tardia não apaga a sessão do login explícito seguinte", async () => {
  const env = coordSetup();
  const j = jar().apply(await env.bff.login(loginReq()));
  const gLogin = env.pause("/auth/login");
  const pending = env.bff.login(loginReq(j));                           // tentativa A
  await gLogin.reached.promise;
  j.apply(await env.bff.logout(logoutReq(j)));                          // logout (aba B)
  const gRevoke = env.pause("/auth/logout");                            // A vai revogar seus tokens
  gLogin.go.resolve();
  await gRevoke.reached.promise;
  const explicit = await env.bff.login(loginReq(j));                    // login explícito depois do logout
  assert.equal(explicit.status, 200);
  j.apply(explicit);
  const winner = j.header();
  gRevoke.go.resolve();
  const late = await pending;
  assert.equal(late.status, 409);
  j.apply(late);
  assert.equal(j.header(), winner);                                     // cookie vencedor intacto
  assert.equal((await sessionOf(env, j)).authenticated, true);
});

test("resposta cancelada NÃO apaga o cookie do login vencedor (cenário da auditoria)", async () => {
  const env = coordSetup();
  const j = jar().apply(await env.bff.login(loginReq()));
  const g = env.pause("/auth/login");
  const a = env.bff.login(loginReq(j));                                 // A pausado
  await g.reached.promise;
  const b = await env.bff.login(loginReq(j));                           // B conclui
  assert.equal(b.status, 200);
  j.apply(b);
  const winner = j.header();
  const winnerName = j.sessionNames()[0];
  g.go.resolve();
  const ra = await a;
  assert.equal(ra.status, 409);
  assert.ok(ra.headers.getSetCookie().every((c) => !c.startsWith(`${winnerName}=`)));
  j.apply(ra);
  assert.equal(j.header(), winner);
  assert.equal((await sessionOf(env, j)).authenticated, true);
  assert.equal(env.store.size, 1);
});

test("expulsão impossível: logouts com IDs arbitrários não reabilitam um cookie encerrado (cenário da auditoria)", async () => {
  const env = coordSetup({ PRAZOAI_BFF_MAX_SESSIONS: "1" });
  const j = jar().apply(await env.bff.login(loginReq()));
  const old = j.header();
  j.apply(await env.bff.logout(logoutReq(j)));
  for (let i = 0; i < 50; i++) {
    const forged = `prazoai_sid_${String(i).padStart(10, "a")}=${"Z".repeat(42)}${i % 10}`;
    await env.bff.logout(req("POST", "/bff/auth/logout", { cookie: forged }));
  }
  const loginsBefore = env.backend.calls.filter((c) => c.path === "/auth/login").length;
  const r = await env.bff.login(req("POST", "/bff/auth/login", { body: creds, cookie: old }));
  assert.equal(r.status, 409);
  assert.equal((await r.json()).error.code, "session_resync_required");
  assert.equal(env.backend.calls.filter((c) => c.path === "/auth/login").length, loginsBefore);   // nem foi ao backend
  assert.equal(env.store.size, 0);
});

test("cookie encerrado por expiração também não é reabilitado; ressincronizar e entrar de novo funciona", async () => {
  const env = coordSetup();
  const j = jar().apply(await env.bff.login(loginReq()));
  env.clock.advance(9 * 3600 * 1000);                                    // passou da inatividade (8 h)
  const r = await env.bff.login(loginReq(j));
  assert.equal(r.status, 409);
  assert.equal((await r.json()).error.code, "session_resync_required");
  j.apply(r);                                                            // apaga só os cookies mortos observados
  assert.equal(j.sessionNames().length, 0);
  const again = await env.bff.login(loginReq(j));                        // tentativa explícita
  assert.equal(again.status, 200);
});

test("ressincronização: GET /bff/session apaga cookies mortos (só pelos nomes observados)", async () => {
  const env = coordSetup();
  const j = jar().apply(await env.bff.login(loginReq()));
  const stale = j.header();
  j.apply(await env.bff.logout(logoutReq(j)));
  const r = await env.bff.session(req("GET", "/bff/session", { cookie: stale }));
  assert.deepEqual(await r.json(), { authenticated: false });
  assert.ok(r.headers.getSetCookie().some((c) => /_sid_[a-z0-9]{10}=;.*Max-Age=0/.test(c)));
});

test("login que chega ao servidor depois do logout (enviado antes) é recusado sem ir ao backend", async () => {
  const env = coordSetup();
  const j = jar().apply(await env.bff.login(loginReq()));
  const inFlight = loginReq(j);                                          // montado ANTES do logout
  await env.bff.logout(logoutReq(j));
  const before = env.backend.calls.length;
  const late = await env.bff.login(inFlight);
  assert.equal(late.status, 409);
  assert.equal(env.backend.calls.length, before);
  assert.equal(env.store.size, 0);
});

test("login explícito depois do logout funciona e reaproveita o identificador do navegador", async () => {
  const env = coordSetup();
  const j = jar().apply(await env.bff.login(loginReq()));
  j.apply(await env.bff.logout(logoutReq(j)));
  const again = await env.bff.login(loginReq(j));
  assert.equal(again.status, 200);
  assert.ok(again.headers.getSetCookie().every((c) => !c.includes("_bid=")));   // bid já existia
  j.apply(again);
  assert.equal((await sessionOf(env, j)).authenticated, true);
});

test("primeiro login pendente (sem cookies) + logout sem sessão: o login conclui (comportamento definido)", async () => {
  const env = coordSetup();
  const g = env.pause("/auth/login");
  const pending = env.bff.login(loginReq());
  await g.reached.promise;
  assert.equal((await env.bff.logout(req("POST", "/bff/auth/logout"))).status, 204);
  g.go.resolve();
  assert.equal((await pending).status, 200);
  assert.equal(env.store.size, 1);
});

test("dois primeiros logins concorrentes: a sessão mais nova vale; a outra é encerrada na ressincronização", async () => {
  const env = coordSetup();
  const g = env.pause("/auth/login");
  const first = env.bff.login(loginReq());
  await g.reached.promise;
  const second = await env.bff.login(loginReq());
  g.go.resolve();
  const j = jar().apply(second).apply(await first);
  assert.equal(j.sessionNames().length, 2);
  const r = await env.bff.session(req("GET", "/bff/session", { cookie: j.header() }));
  assert.equal((await r.json()).authenticated, true);
  j.apply(r);
  assert.equal(j.sessionNames().length, 1);
  assert.equal(env.store.size, 1);
  j.apply(await env.bff.logout(logoutReq(j)));
  assert.equal(env.store.size, 0);
});

test("login com credenciais erradas preserva a sessão anterior", async () => {
  const env = coordSetup();
  const j = jar().apply(await env.bff.login(loginReq()));
  env.backend.loginStatus = 401;
  const r = await env.bff.login(loginReq(j));
  assert.equal(r.status, 401);
  assert.equal(r.headers.getSetCookie().length, 0);
  assert.equal((await sessionOf(env, j)).authenticated, true);
});

test("capacidade na seção crítica: 503, tokens novos revogados, sessão anterior intacta", async () => {
  const env = coordSetup({ PRAZOAI_BFF_MAX_SESSIONS: "1" });
  const j = jar().apply(await env.bff.login(loginReq()));
  const other = jar();
  const r = await env.bff.login(loginReq(other));                       // outro navegador
  assert.equal(r.status, 503);
  assert.equal(env.backend.sessions.at(-1).revoked, true);
  assert.equal((await sessionOf(env, j)).authenticated, true);
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
