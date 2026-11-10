// Etapa 6.2 — BFF (allowlist e consulta pública de convite) e bibliotecas de cliente, com DUBLÊS.
import test from "node:test";
import assert from "node:assert/strict";
import { matchAllowlist, PROXY_ALLOWLIST } from "../src/server/bff/allowlist.mjs";
import { loadBffConfig } from "../src/server/bff/config.mjs";
import { createMemorySessionStore } from "../src/server/bff/session-store.mjs";
import { createBff } from "../src/server/bff/manager.mjs";
import { createApiClient } from "../src/lib/integration/api-client.mjs";
import { createOrgClient } from "../src/lib/integration/org-client.mjs";
import { buildInviteLink, captureInviteToken, parseInviteFragment } from "../src/lib/integration/invite-token.mjs";
import { canEditTarget, capabilities, createOrgController, grantablePermissions } from "../src/lib/integration/org-controller.mjs";
import { cacheKey, createQueryCache } from "../src/lib/integration/query-cache.mjs";
import { createFakeBackend, deferred } from "./helpers/fake-backend.mjs";

const ORIGIN = "http://localhost:3000";
const ID = "a".repeat(32);
const TOKEN = "T".repeat(43);
const json = (status, body) => new Response(body === null ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

// ---------------------------------------------------------------- allowlist
test("allowlist 6.2: rotas necessárias liberadas, segmentos dinâmicos validados", () => {
  const ok = [
    ["GET", "/memberships/me"], ["POST", "/offices"], ["GET", `/offices/${ID}`], ["PATCH", `/offices/${ID}`],
    ["GET", `/offices/${ID}/members`], ["PATCH", `/offices/${ID}/members/${ID}`], ["POST", `/offices/${ID}/members/${ID}/promote`],
    ["POST", `/offices/${ID}/members/${ID}/remove`], ["POST", `/offices/${ID}/leave`], ["GET", `/offices/${ID}/join-code`],
    ["POST", `/offices/${ID}/join-code/rotate`], ["GET", `/offices/${ID}/invitations`], ["POST", `/offices/${ID}/invitations`],
    ["POST", `/offices/${ID}/invitations/${ID}/revoke`], ["GET", `/offices/${ID}/join-requests`],
    ["POST", `/offices/${ID}/join-requests/${ID}/approve`], ["POST", `/offices/${ID}/join-requests/${ID}/reject`],
    ["POST", "/invitations/accept"], ["POST", "/join-requests"], ["GET", "/join-requests/me"], ["POST", `/join-requests/${ID}/cancel`],
  ];
  for (const [m, p] of ok) assert.equal(matchAllowlist(m, p), "ok", `${m} ${p}`);
  assert.equal(matchAllowlist("POST", "/invitations/lookup"), "not_found");           // pública: rota própria
  assert.equal(matchAllowlist("DELETE", `/offices/${ID}/members/${ID}`), "method_not_allowed");
  assert.equal(matchAllowlist("GET", "/intimations"), "not_found");                     // módulos futuros fora
  assert.equal(matchAllowlist("GET", "/notifications"), "not_found");
  assert.equal(matchAllowlist("GET", `/offices/${ID}/members/${ID}/extra`), "not_found");
  assert.equal(matchAllowlist("GET", `/offices/${"x".repeat(65)}`), "not_found");
  assert.equal(matchAllowlist("GET", "/offices/a.b"), "not_found");
  assert.equal(matchAllowlist("GET", "/offices//members"), "not_found");
  assert.ok(PROXY_ALLOWLIST.every((r) => !r.path.includes("refresh") && !r.path.includes("login")));
});

// ---------------------------------------------------------------- consulta pública de convite
function bffWith(handler) {
  const config = loadBffConfig({ PRAZOAI_APP_ENV: "test", PRAZOAI_APP_ORIGIN: ORIGIN, PRAZOAI_COOKIE_INSECURE_LOCAL: "true" });
  const calls = [];
  const logs = [];
  const fetchImpl = async (url, init) => { calls.push({ url, init }); return handler(url, init); };
  const bff = createBff({ config, store: createMemorySessionStore(config.session), fetchImpl, logger: { info: (...a) => logs.push(JSON.stringify(a)) } });
  return { bff, calls, logs };
}
const lookupReq = (body, { origin = ORIGIN, csrf = true, cookie } = {}) => {
  const h = new Headers({ "content-type": "application/json" });
  if (csrf) h.set("x-prazoai-csrf", "1");
  if (origin) h.set("origin", origin);
  if (cookie) h.set("cookie", cookie);
  return new Request(`${ORIGIN}/bff/public/invitations/lookup`, { method: "POST", headers: h, body: JSON.stringify(body) });
};

test("consulta pública: sem sessão, token só no corpo, sem cookies e sem logs do token", async () => {
  const { bff, calls, logs } = bffWith(() => json(200, { state: "valid", officeName: "Silva & Souza" }));
  const r = await bff.publicInvitationLookup(lookupReq({ token: TOKEN }, { cookie: "prazoai_sid_abcdefghij=x" }));
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { state: "valid", officeName: "Silva & Souza" });
  assert.equal(r.headers.getSetCookie().length, 0);
  assert.equal(r.headers.get("cache-control"), "no-store, private");
  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.endsWith("/api/v1/invitations/lookup"));
  assert.ok(!calls[0].url.includes(TOKEN));
  assert.deepEqual(JSON.parse(calls[0].init.body), { token: TOKEN });
  assert.equal(calls[0].init.headers.authorization, undefined);                       // nunca autentica
  assert.equal(logs.some((l) => l.includes(TOKEN)), false);
});

test("consulta pública: CSRF/Origin exigidos e corpo estrito", async () => {
  const { bff, calls } = bffWith(() => json(200, { state: "valid" }));
  assert.equal((await bff.publicInvitationLookup(lookupReq({ token: TOKEN }, { csrf: false }))).status, 403);
  assert.equal((await bff.publicInvitationLookup(lookupReq({ token: TOKEN }, { origin: "http://evil.example" }))).status, 403);
  assert.equal((await bff.publicInvitationLookup(lookupReq({ token: "curto" }))).status, 422);
  assert.equal((await bff.publicInvitationLookup(lookupReq({ token: TOKEN, url: "http://x" }))).status, 422);
  assert.equal(calls.length, 0);
});

test("consulta pública: 429 preservado e indisponibilidade distinta", async () => {
  let r = await bffWith(() => new Response(JSON.stringify({ error: { code: "rate_limited", message: "x" } }),
    { status: 429, headers: { "retry-after": "60" } })).bff.publicInvitationLookup(lookupReq({ token: TOKEN }));
  assert.equal(r.status, 429);
  assert.equal(r.headers.get("retry-after"), "60");
  r = await bffWith(() => { const e = new TypeError("x"); e.cause = { code: "ECONNREFUSED" }; throw e; }).bff.publicInvitationLookup(lookupReq({ token: TOKEN }));
  assert.equal(r.status, 503);
});

// ---------------------------------------------------------------- cliente
test("cliente da 6.2: caminhos corretos, IDs validados, token do convite só no corpo", async () => {
  const seen = [];
  const api = createApiClient({ fetchImpl: async (url, init) => { seen.push({ url, init }); return json(200, {}); } });
  const org = createOrgClient(api);
  await org.lookupInvitation(TOKEN);
  await org.acceptInvitation(TOKEN);
  await org.removeMember(ID, ID, ID);
  await org.leave(ID, { successorUserId: ID });
  assert.equal(seen[0].url, "/bff/public/invitations/lookup");
  assert.equal(seen[1].url, "/bff/api/invitations/accept");
  assert.ok(seen.every((c) => !c.url.includes(TOKEN)));
  assert.deepEqual(JSON.parse(seen[1].init.body), { token: TOKEN });
  assert.deepEqual(JSON.parse(seen[2].init.body), { reassignTo: ID });
  assert.deepEqual(JSON.parse(seen[3].init.body), { successorUserId: ID });
  assert.throws(() => org.office("../x"));
  assert.throws(() => org.updateMember(ID, "a/b", {}));
});

// ---------------------------------------------------------------- token do convite
test("token do convite: só do fragmento, removido da barra sem navegar", () => {
  assert.equal(parseInviteFragment(`#${TOKEN}`), TOKEN);
  for (const bad of ["", "#", "#curto", `#${TOKEN}?x=1`, `#${TOKEN}/a`, TOKEN]) assert.equal(parseInviteFragment(bad), null, bad);
  const calls = [];
  const win = { location: { hash: `#${TOKEN}`, pathname: "/convite" }, history: { replaceState: (...a) => calls.push(a) } };
  assert.equal(captureInviteToken(win), TOKEN);
  assert.deepEqual(calls, [[null, "", "/convite"]]);                                // sem token na URL resultante
  assert.equal(buildInviteLink("http://localhost:3000/", TOKEN), `http://localhost:3000/convite#${TOKEN}`);
  assert.throws(() => buildInviteLink("http://x", "a/b"));
});

// ---------------------------------------------------------------- capacidades
const member = (perms, visibility = "assigned") => ({ officeId: "o", roleLabel: "Sócio", practiceAreas: [], permissions: perms, visibility, joinedAt: "" });
const ADMIN = ["deadline.read", "deadline.create", "deadline.edit", "deadline.complete", "deadline.transfer", "team.manage", "office.manage"];
const MANAGER = ["deadline.read", "deadline.create", "deadline.edit", "deadline.complete", "team.manage"];

test("capacidades: cargo não concede nada; delegação limitada; gestor não edita gestores", () => {
  assert.equal(capabilities(member([], "all")).canManageTeam, false);                 // cargo "Sócio" sem permissões
  assert.equal(capabilities(member(ADMIN)).isAdmin, true);
  assert.equal(capabilities(member(MANAGER)).isAdmin, false);
  assert.equal(capabilities(member(MANAGER)).canGrantEntry, true);
  assert.equal(capabilities(member(["team.manage", "deadline.read"])).canGrantEntry, false);
  assert.deepEqual(grantablePermissions(member(MANAGER)), ["deadline.read", "deadline.create", "deadline.edit", "deadline.complete"]);
  assert.ok(grantablePermissions(member(ADMIN)).includes("office.manage"));
  const target = (perms) => ({ userId: "t", name: "T", roleLabel: "x", practiceAreas: [], email: "", permissions: perms, visibility: "assigned", joinedAt: "" });
  assert.equal(canEditTarget(member(MANAGER), "me", target(["deadline.read"])), true);
  assert.equal(canEditTarget(member(MANAGER), "me", target(MANAGER)), false);         // outro gestor
  assert.equal(canEditTarget(member(MANAGER), "me", target(ADMIN)), false);
  assert.equal(canEditTarget(member(ADMIN), "me", target(MANAGER)), true);
  assert.equal(canEditTarget(member(ADMIN), "t", target(["deadline.read"])), false);  // a si mesmo
  assert.equal(canEditTarget(member(["deadline.read"]), "me", target(["deadline.read"])), false);
});

// ---------------------------------------------------------------- controlador de vínculo
function orgCtl(responses) {
  const queue = [...responses];
  const resets = [];
  const posted = [];
  const api = createApiClient({ fetchImpl: async () => { const r = queue.shift(); return typeof r === "function" ? r() : r; } });
  const org = createOrgClient(api);
  const channel = { postMessage: (m) => posted.push(m), onmessage: null };
  const ctl = createOrgController({ org, api, channel, onReset: (i) => resets.push(i.reason) });
  return { ctl, resets, posted, channel, api, queue };
}
const officeResp = (perms = ADMIN, id = "o1") => json(200, { office: { id, name: "Escritório", createdAt: "" }, membership: member(perms) });
const noOffice = () => json(200, { office: null, membership: null });

test("vínculo: ambiente inicial, seleção é só navegação e escritório exige vínculo", async () => {
  let x = orgCtl([noOffice()]);
  await x.ctl.refresh({ userId: "u1" });
  assert.equal(x.ctl.state.scope, "personal");
  assert.equal(x.ctl.selectScope("office"), false);                                    // sem vínculo, sem escritório
  x = orgCtl([officeResp(), officeResp()]);
  await x.ctl.refresh({ userId: "u1" });
  assert.equal(x.ctl.state.scope, "office");
  assert.equal(x.ctl.selectScope("personal"), true);
  await x.ctl.refresh();
  assert.equal(x.ctl.state.scope, "personal");                                         // escolha preservada
});

test("vínculo: perda de vínculo ou mudança de permissões limpa dados e volta ao pessoal", async () => {
  const x = orgCtl([officeResp(), officeResp(MANAGER), noOffice()]);
  await x.ctl.refresh({ userId: "u1" });
  const before = x.resets.length;
  await x.ctl.refresh();                                                               // permissões mudaram
  assert.ok(x.resets.length > before);
  await x.ctl.refresh();                                                               // vínculo perdido
  assert.equal(x.ctl.state.office, null);
  assert.equal(x.ctl.state.scope, "personal");
  assert.equal(x.resets.at(-1), "no-office");
});

test("vínculo: resposta antiga não sobrescreve a mais nova (troca de usuário)", async () => {
  const gate = deferred();
  const x = orgCtl([async () => { await gate.promise; return officeResp(ADMIN, "antigo"); }, noOffice()]);
  const first = x.ctl.refresh({ userId: "u1" });
  x.ctl.reset("u2");
  await x.ctl.refresh({ userId: "u2" });
  gate.resolve();
  await first.catch(() => {});
  assert.equal(x.ctl.state.userId, "u2");
  assert.equal(x.ctl.state.office, null);
});

test("vínculo: indisponível é estado próprio; aviso de outra aba só ressincroniza", async () => {
  const x = orgCtl([json(503, { error: { code: "backend_unavailable", message: "x" } }), officeResp(), officeResp()]);
  await assert.rejects(x.ctl.refresh({ userId: "u1" }));
  assert.equal(x.ctl.state.status, "unavailable");
  x.channel.onmessage({ data: { type: "org-changed" } });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(x.ctl.state.status, "ready");
  await x.ctl.changed();
  assert.deepEqual(x.posted, [{ type: "org-changed" }]);
});

test("vínculo: preferência de ambiente sobrevive ao recarregamento, mas não cria acesso", async () => {
  const saved = new Map();
  const scopeStore = { get: (u) => saved.get(u) ?? null, set: (u, v) => saved.set(u, v) };
  const make = (responses) => {
    const queue = [...responses];
    const api = createApiClient({ fetchImpl: async () => queue.shift() });
    return createOrgController({ org: createOrgClient(api), api, scopeStore });
  };
  let ctl = make([officeResp()]);
  await ctl.refresh({ userId: "u1" });
  ctl.selectScope("personal");
  ctl = make([officeResp()]);                                                          // "recarregou a página"
  await ctl.refresh({ userId: "u1" });
  assert.equal(ctl.state.scope, "personal");
  saved.set("u2", "office");                                                           // preferência sem vínculo
  ctl = make([noOffice()]);
  await ctl.refresh({ userId: "u2" });
  assert.equal(ctl.state.scope, "personal");
});

// ---------------------------------------------------------------- auditoria 6.2
test("auditoria 6.2: aprovar exige ingresso completo; rejeitar só team.manage", () => {
  const minimo = capabilities(member(["deadline.read", "team.manage"]));
  assert.equal(minimo.canRejectRequests, true);
  assert.equal(minimo.canApproveRequests, false);
  assert.equal(capabilities(member(MANAGER)).canApproveRequests, true);
  assert.equal(capabilities(member(["deadline.read"])).canRejectRequests, false);
});

test("auditoria 6.2: revisão de autorização muda com permissões/visibilidade/vínculo e entra na chave", async () => {
  const x = orgCtl([officeResp(MANAGER), officeResp(MANAGER), officeResp(["deadline.read"]), noOffice()]);
  await x.ctl.refresh({ userId: "u1" });
  const r0 = x.ctl.state.revision;
  await x.ctl.refresh();                                                             // nada mudou
  assert.equal(x.ctl.state.revision, r0);
  await x.ctl.refresh();                                                             // perdeu team.manage
  assert.equal(x.ctl.state.revision, r0 + 1);
  await x.ctl.refresh();                                                             // perdeu o vínculo
  assert.equal(x.ctl.state.revision, r0 + 2);
  const k1 = cacheKey({ userId: "u1", officeId: "o1", scope: "office", revision: 1 }, "members");
  const k2 = cacheKey({ userId: "u1", officeId: "o1", scope: "office", revision: 2 }, "members");
  assert.notEqual(k1, k2);
});

test("auditoria 6.2: resposta pendente da revisão anterior é descartada (época abortada)", async () => {
  const gate = deferred();
  const queue = [officeResp(MANAGER), null, officeResp(["deadline.read"])];
  const api = createApiClient({ fetchImpl: async (url, init) => {
    const r = queue.shift();
    if (r === null) {                                                                // GET /members pausado
      await new Promise((res, rej) => { init.signal.addEventListener("abort", () => rej(new DOMException("x", "AbortError"))); gate.promise.then(res); });
      return json(200, { projection: "admin", members: [{ userId: "a", email: "a@x" }] });
    }
    return r;
  } });
  const org = createOrgClient(api);
  const ctl = createOrgController({ org, api });
  await ctl.refresh({ userId: "u1" });
  const pending = org.members("o1");
  await ctl.refresh();                                                               // perdeu team.manage
  gate.resolve();
  await assert.rejects(pending, (e) => e.name === "StaleResponseError");
});

// ---------------------------------------------------------------- cache
test("cache: chaves por usuário, escritório e ambiente; invalidação e teto", () => {
  const a = cacheKey({ userId: "u1", officeId: "o1", scope: "office" }, "members");
  const b = cacheKey({ userId: "u2", officeId: "o1", scope: "office" }, "members");
  const c = cacheKey({ userId: "u1", officeId: "o2", scope: "office" }, "members");
  const d = cacheKey({ userId: "u1", officeId: "o1", scope: "personal" }, "members");
  assert.equal(new Set([a, b, c, d]).size, 4);
  assert.throws(() => cacheKey({ userId: null, officeId: null, scope: "personal" }, "x"));
  const cache = createQueryCache({ maxEntries: 2 });
  cache.set(a, 1); cache.set(b, 2); cache.set(c, 3);
  assert.equal(cache.get(a), undefined);
  cache.invalidate("u:u2|");
  assert.equal(cache.get(b), undefined);
  assert.equal(cache.get(c), 3);
  cache.clear();
  assert.equal(cache.size, 0);
});

test("fake do backend continua disponível para os testes de sessão", () => { assert.ok(createFakeBackend()); });
