// Dublê do FastAPI para testes UNITÁRIOS do BFF (não é integração real).
// Várias sessões, como o backend real: cada login cria uma sessão com par próprio; o refresh gira
// o par da sessão e detecta reutilização (revoga só aquela sessão); logout revoga a sessão do token.

export function deferred() {
  let resolve; let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

export const tok = (kind, n) => `${kind}${n}-${"x".repeat(24)}`;

const res = (status, body, headers = {}) =>
  new Response(body === null ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

export function createFakeBackend() {
  const sessions = [];                       // { access, refresh, used:Set, revoked }
  const fb = {
    calls: [],
    seq: 1,
    user: { id: "u1", name: "Ana", email: "ana@exemplo.com", createdAt: "2026-11-09T12:00:00Z" },
    beforeRefresh: null,
    failRefresh: null,                       // "timeout" | "refused" | "500" | "401" | "network"
    failNext: null,
    loginStatus: 200,
    sessions,
    /** Sessão mais recente (compatibilidade com os testes anteriores). */
    get current() { return sessions.at(-1) ?? null; },
    get revoked() { return Boolean(sessions.at(-1)?.revoked); },
    set revoked(v) { if (sessions.at(-1)) sessions.at(-1).revoked = v; },
  };
  const fail = (kind) => {
    if (kind === "refused") { const e = new TypeError("fetch failed"); e.cause = { code: "ECONNREFUSED" }; throw e; }
    if (kind === "timeout") { const e = new Error("timeout"); e.name = "TimeoutError"; throw e; }
    if (kind === "network") { const e = new TypeError("fetch failed"); e.cause = { code: "ECONNRESET" }; throw e; }
    return null;
  };
  const issue = (s) => { fb.seq += 1; s.access = tok("a", fb.seq); s.refresh = tok("r", fb.seq); };
  fb.fetch = async (url, init) => {
    const path = new URL(url).pathname.replace("/api/v1", "");
    const headers = Object.fromEntries(Object.entries(init.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
    const body = init.body ? JSON.parse(init.body) : undefined;
    fb.calls.push({ path, method: init.method, headers, body, redirect: init.redirect });
    const auth = headers.authorization?.replace("Bearer ", "");
    if (path === "/auth/refresh") {
      if (fb.beforeRefresh) await fb.beforeRefresh();
      if (fb.failRefresh === "500") return res(500, { error: { code: "internal_error", message: "x" } });
      if (fb.failRefresh === "401") return res(401, { error: { code: "invalid_refresh_token", message: "x" } });
      if (fb.failRefresh) fail(fb.failRefresh);
      const reused = sessions.find((s) => s.used.has(body.refreshToken));
      if (reused) { reused.revoked = true; return res(401, { error: { code: "invalid_refresh_token", message: "x" } }); }
      const s = sessions.find((x) => x.refresh === body.refreshToken);
      if (!s || s.revoked) return res(401, { error: { code: "invalid_refresh_token", message: "x" } });
      s.used.add(s.refresh);
      issue(s);
      return res(200, { accessToken: s.access, refreshToken: s.refresh, tokenType: "Bearer", expiresIn: 900 });
    }
    if (fb.failNext) {
      const k = fb.failNext; fb.failNext = null;
      if (k === "500") return res(500, {});
      if (k === "429") return res(429, { error: { code: "rate_limited", message: "x" } }, { "retry-after": "60" });
      if (k === "redirect") return new Response(null, { status: 302, headers: { location: "http://evil.example/" } });
      fail(k);
    }
    if (path === "/auth/login") {
      if (fb.loginStatus !== 200) {
        return res(fb.loginStatus, { error: { code: fb.loginStatus === 429 ? "rate_limited" : "invalid_credentials", message: "x" } },
          fb.loginStatus === 429 ? { "retry-after": "300" } : {});
      }
      const s = { used: new Set(), revoked: false };
      issue(s);
      sessions.push(s);
      return res(200, { accessToken: s.access, refreshToken: s.refresh, tokenType: "Bearer", expiresIn: 900, user: fb.user });
    }
    if (path === "/auth/register") return res(201, fb.user);
    const s = sessions.find((x) => x.access === auth && !x.revoked);
    if (path === "/auth/logout") {
      if (s) { s.revoked = true; return new Response(null, { status: 204 }); }
      return res(401, { error: { code: "invalid_token", message: "x" } });
    }
    if (!s) return res(401, { error: { code: "invalid_token", message: "x" } });
    if (path === "/auth/me") return res(200, { user: fb.user });
    if (path === "/users/me" && init.method === "GET") return res(200, fb.user);
    if (path === "/users/me" && init.method === "PATCH") { fb.user = { ...fb.user, ...body }; return res(200, fb.user); }
    return res(404, { error: { code: "not_found", message: "x" } });
  };
  return fb;
}
