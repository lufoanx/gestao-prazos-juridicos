// Etapa 6.1 — cliente do navegador e controlador de sessão com DUBLÊS (testes unitários).
import test from "node:test";
import assert from "node:assert/strict";
import { createApiClient, ApiError, StaleResponseError } from "../src/lib/integration/api-client.mjs";
import { createAuthController } from "../src/lib/integration/auth-controller.mjs";
import { routeDecision } from "../src/lib/integration/routes.mjs";
import { resolveMode } from "../src/lib/integration/mode.mjs";
import { deferred } from "./helpers/fake-backend.mjs";

const json = (status, body, headers = {}) =>
  new Response(body === null ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

test("cliente: cabeçalho anti-CSRF, mesma origem, sem cache e só caminhos do BFF", async () => {
  const seen = [];
  const api = createApiClient({ fetchImpl: async (url, init) => { seen.push({ url, init }); return json(200, { ok: 1 }); } });
  await api.request("PATCH", "/bff/api/users/me", { name: "Ana" });
  assert.equal(seen[0].init.headers["x-prazoai-csrf"], "1");
  assert.equal(seen[0].init.credentials, "same-origin");
  assert.equal(seen[0].init.cache, "no-store");
  await assert.rejects(api.request("GET", "http://127.0.0.1:8000/api/v1/users/me"));
});

test("cliente: categorias de erro distintas (nunca tudo vira expiração)", async () => {
  const cases = [
    [json(401, { error: { code: "session_expired", message: "x" } }), "session"],
    [json(429, { error: { code: "rate_limited", message: "x" } }, { "retry-after": "60" }), "rate_limited"],
    [json(503, { error: { code: "backend_unavailable", message: "x" } }), "unavailable"],
    [json(504, { error: { code: "upstream_timeout", message: "x" }, outcome: "unknown" }), "unknown_outcome"],
    [json(409, { error: { code: "version_conflict", message: "x" } }), "conflict"],
    [json(403, { error: { code: "forbidden", message: "x" } }), "forbidden"],
  ];
  for (const [response, category] of cases) {
    const api = createApiClient({ fetchImpl: async () => response });
    const err = await api.request("GET", "/bff/session").catch((e) => e);
    assert.ok(err instanceof ApiError);
    assert.equal(err.category, category);
    if (category === "rate_limited") assert.equal(err.retryAfter, "60");
  }
  const offline = createApiClient({ fetchImpl: async () => { throw new TypeError("offline"); } });
  const err = await offline.request("GET", "/bff/session").catch((e) => e);
  assert.equal(err.category, "network");                        // sem dados demonstrativos de reserva
});

test("cliente: resposta de época anterior é descartada e pendentes são abortadas", async () => {
  const gate = deferred();
  let aborted = false;
  const api = createApiClient({ fetchImpl: async (url, init) => {
    init.signal.addEventListener("abort", () => { aborted = true; });
    await gate.promise;
    return json(200, { user: { id: "antigo" } });
  } });
  const p = api.request("GET", "/bff/session");
  api.bumpEpoch();
  gate.resolve();
  await assert.rejects(p, StaleResponseError);
  assert.equal(aborted, true);
});

function controllerWith(handler, extra = {}) {
  const calls = [];
  const api = createApiClient({ fetchImpl: async (url, init) => { calls.push({ url, method: init.method }); return handler(url, init); } });
  let resets = 0;
  const posted = [];
  const channel = { postMessage: (m) => posted.push(m), onmessage: null };
  const ctl = createAuthController({ api, channel, onReset: () => { resets += 1; }, ...extra });
  return { ctl, calls, posted, channel, resets: () => resets };
}

test("controlador: restaurar distingue anônimo, autenticado, expirado e indisponível", async () => {
  const user = { id: "u1", name: "Ana", email: "a@b.com", createdAt: "x" };
  let ctx = controllerWith(() => json(200, { authenticated: true, user }));
  await ctx.ctl.restore();
  assert.equal(ctx.ctl.state.status, "authenticated");
  ctx = controllerWith(() => json(200, { authenticated: false }));
  await ctx.ctl.restore();
  assert.equal(ctx.ctl.state.status, "anonymous");
  ctx = controllerWith(() => json(401, { error: { code: "session_refresh_uncertain", message: "x" } }));
  await ctx.ctl.restore();
  assert.deepEqual([ctx.ctl.state.status, ctx.ctl.state.error], ["expired", "session_refresh_uncertain"]);
  ctx = controllerWith(() => json(503, { error: { code: "backend_unavailable", message: "x" } }));
  await ctx.ctl.restore();
  assert.equal(ctx.ctl.state.status, "unavailable");
  assert.equal(ctx.calls.some((c) => c.url.includes("logout")), false);      // sem logout indevido
});

test("controlador: logout durante login espera e encerra — resposta atrasada não ressuscita a sessão", async () => {
  const user = { id: "u1", name: "Ana", email: "a@b.com", createdAt: "x" };
  const gate = deferred();
  const ctx = controllerWith(async (url) => {
    if (url.endsWith("/login")) { await gate.promise; return json(200, { user }); }
    return json(204, null);
  });
  const loginP = ctx.ctl.login("a@b.com", "Senha-123");
  const logoutP = ctx.ctl.logout();
  gate.resolve();
  await loginP;
  await logoutP;
  assert.equal(ctx.ctl.state.status, "anonymous");
  assert.deepEqual(ctx.calls.map((c) => c.url), ["/bff/auth/login", "/bff/auth/logout"]);
  assert.deepEqual(ctx.posted.map((m) => m.type), ["login", "logout"]);
});

test("controlador: falha de login deixa anônimo (o BFF encerra a sessão anterior)", async () => {
  const ctx = controllerWith(() => json(401, { error: { code: "invalid_credentials", message: "x" } }));
  await assert.rejects(ctx.ctl.login("a@b.com", "errada"));
  assert.equal(ctx.ctl.state.status, "anonymous");
});

test("controlador: avisos de outras abas limpam o estado (não são autorização)", async () => {
  const user = { id: "u1", name: "Ana", email: "a@b.com", createdAt: "x" };
  const other = { id: "u2", name: "Bia", email: "b@b.com", createdAt: "x" };
  let current = user;
  const ctx = controllerWith((url) => url.endsWith("/session")
    ? json(200, current ? { authenticated: true, user: current } : { authenticated: false }) : json(200, {}));
  await ctx.ctl.restore();
  const r0 = ctx.resets();
  current = null;                                                // o servidor já não tem sessão
  ctx.ctl.onMessage({ type: "logout" });
  assert.equal(ctx.ctl.state.status, "loading");                 // limpa e ressincroniza (aviso não é autoridade)
  assert.ok(ctx.resets() > r0);
  await ctx.ctl.restore();
  assert.equal(ctx.ctl.state.status, "anonymous");
  current = other;
  ctx.ctl.onMessage({ type: "login", userId: "u2" });
  await new Promise((r) => setTimeout(r, 0));
  await ctx.ctl.restore();
  assert.equal(ctx.ctl.state.user.id, "u2");
  ctx.ctl.sessionEnded("session_expired");
  assert.equal(ctx.ctl.state.status, "expired");
});

test("rotas: modo integrado reescreve módulos não integrados e recursos indisponíveis", () => {
  assert.deepEqual(routeDecision("/app/prazos", "demo"), { action: "allow" });
  assert.deepEqual(routeDecision("/app/perfil", "integrated"), { action: "allow" });
  assert.deepEqual(routeDecision("/app", "integrated"), { action: "allow" });
  assert.deepEqual(routeDecision("/app/prazos/123", "integrated"), { action: "rewrite", to: "/app/nao-integrado" });
  assert.deepEqual(routeDecision("/esqueci-senha", "integrated"), { action: "rewrite", to: "/indisponivel" });
  assert.deepEqual(routeDecision("/redefinir-senha/abc", "integrated"), { action: "rewrite", to: "/indisponivel" });
  assert.deepEqual(routeDecision("/convite/abc", "integrated"), { action: "rewrite", to: "/nao-integrado" });
  assert.deepEqual(routeDecision("/login", "integrated"), { action: "allow" });
  assert.deepEqual(routeDecision("/bff/session", "integrated"), { action: "allow" });
});

test("modo: explícito; inválido é erro; ausente = demo (sem troca automática)", () => {
  assert.equal(resolveMode(undefined), "demo");
  assert.equal(resolveMode("integrated"), "integrated");
  assert.throws(() => resolveMode("auto"));
});
