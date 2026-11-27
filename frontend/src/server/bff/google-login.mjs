// "Entrar com Google" no BFF (OAuth 2.0 Authorization Code + PKCE + state + nonce).
//
// Fluxo:
// 1. GET /bff/auth/google/start: gera state, nonce e code_verifier; guarda-os num cookie CIFRADO e de
//    curta duração (AES-256-GCM, chave derivada do client secret, só no servidor) e redireciona ao Google.
// 2. GET /bff/auth/google/callback: confere o state do cookie (tempo constante, uso único: o cookie é
//    apagado em qualquer resultado), troca o código por tokens DIRETO com o Google (client secret +
//    code_verifier) e entrega SÓ o ID token + nonce ao backend, que verifica a identidade.
// 3. A sessão é criada pelo MESMO núcleo do login por senha (coordenação atômica de sessões).
// Nenhum token do Google ou do backend chega ao navegador; nada sensível é registrado em log.
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes, timingSafeEqual, createHash } from "node:crypto";
import { NO_STORE } from "./security.mjs";

const STATE_TTL_MS = 10 * 60 * 1000;
const MAX_TOKEN_RESPONSE = 64 * 1024;
export const GOOGLE_ERRORS = new Set(["indisponivel", "cancelado", "expirado", "falhou", "limite", "conta"]);

function b64url(buf) { return Buffer.from(buf).toString("base64url"); }

export function stateCookieName(config) {
  return config.cookie.secure ? "__Host-prazoai_gauth" : "prazoai_gauth";
}

function cookie(config, value, maxAgeSeconds) {
  // SameSite=Lax: o retorno do Google é uma navegação de nível superior vinda de outro site.
  const parts = [`${stateCookieName(config)}=${value}`, "Path=/", "HttpOnly", "SameSite=Lax"];
  if (config.cookie.secure) parts.push("Secure");
  parts.push(`Max-Age=${maxAgeSeconds}`);
  return parts.join("; ");
}

function readCookie(request, name) {
  const header = request.headers.get("cookie") || "";
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx > 0 && part.slice(0, idx).trim() === name) return part.slice(idx + 1).trim();
  }
  return null;
}

function redirect(location, cookies = []) {
  const headers = new Headers({ ...NO_STORE, location, "referrer-policy": "no-referrer" });
  for (const c of cookies) headers.append("set-cookie", c);
  return new Response(null, { status: 303, headers });
}

/**
 * Página de transição após o login: o cookie de sessão é SameSite=Strict, e uma cadeia de
 * redirecionamentos iniciada no Google não o enviaria na primeira página. Uma navegação disparada
 * pela própria página do PrazoAI (meta refresh, sem script) é do mesmo site e já leva a sessão.
 */
function landing(path, cookies) {
  const headers = new Headers({ ...NO_STORE, "content-type": "text/html; charset=utf-8", "referrer-policy": "no-referrer",
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'" });
  for (const c of cookies) headers.append("set-cookie", c);
  const body = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="robots" content="noindex">`
    + `<meta http-equiv="refresh" content="0;url=${path}"><title>Entrando…</title></head>`
    + `<body style="font-family:system-ui,sans-serif;padding:2rem">Entrando no PrazoAI… <a href="${path}">Continuar</a></body></html>`;
  return new Response(body, { status: 200, headers });
}

export function createGoogleLogin({ config, fetchImpl = fetch, now = () => Date.now(), log = () => {}, performLogin }) {
  const g = config.google;
  const key = g ? Buffer.from(hkdfSync("sha256", Buffer.from(config.googleClientSecret, "utf8"),
    Buffer.from("prazoai-bff"), Buffer.from("google-oauth-state:v1"), 32)) : null;
  const aad = Buffer.from("prazoai-google-state:v1");
  const appUrl = (path) => new URL(path, config.appOrigin).toString();
  const fail = (code) => redirect(appUrl(`/login?google=${code}`), [cookie(config, "", 0)]);

  function seal(obj) {
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", key, iv);
    c.setAAD(aad);
    const ct = Buffer.concat([c.update(JSON.stringify(obj), "utf8"), c.final()]);
    return b64url(Buffer.concat([iv, c.getAuthTag(), ct]));
  }

  function unseal(value) {
    try {
      const buf = Buffer.from(value || "", "base64url");
      if (buf.length < 12 + 16 + 2 || buf.length > 2048) return null;
      const d = createDecipheriv("aes-256-gcm", key, buf.subarray(0, 12));
      d.setAAD(aad);
      d.setAuthTag(buf.subarray(12, 28));
      return JSON.parse(Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString("utf8"));
    } catch {
      return null;
    }
  }

  function status() {
    return new Response(JSON.stringify({ available: Boolean(g) }), {
      status: 200, headers: { ...NO_STORE, "content-type": "application/json; charset=utf-8" },
    });
  }

  function start() {
    if (!g) return fail("indisponivel");
    const state = b64url(randomBytes(32));
    const nonce = b64url(randomBytes(32));
    const verifier = b64url(randomBytes(48));
    const challenge = b64url(createHash("sha256").update(verifier).digest());
    const url = new URL(g.authorizeUrl);
    url.search = new URLSearchParams({
      client_id: g.clientId, redirect_uri: g.redirectUri, response_type: "code", scope: "openid email profile",
      state, nonce, code_challenge: challenge, code_challenge_method: "S256", prompt: "select_account",
    }).toString();
    log("google_start");
    return redirect(url.toString(), [cookie(config, seal({ s: state, n: nonce, v: verifier, e: now() + STATE_TTL_MS }),
      Math.floor(STATE_TTL_MS / 1000))]);
  }

  async function exchange(code, verifier) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.timeoutMs);
    try {
      const res = await fetchImpl(g.tokenUrl, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body: new URLSearchParams({
          code, client_id: g.clientId, client_secret: config.googleClientSecret, redirect_uri: g.redirectUri,
          grant_type: "authorization_code", code_verifier: verifier,
        }).toString(),
        signal: controller.signal,
        redirect: "error",
      });
      const text = await res.text();
      if (!res.ok || text.length > MAX_TOKEN_RESPONSE) return { error: res.status >= 500 ? "indisponivel" : "falhou" };
      const idToken = JSON.parse(text)?.id_token;
      return typeof idToken === "string" && idToken.length >= 16 && idToken.length <= 8192
        ? { idToken } : { error: "falhou" };
    } catch {
      return { error: "indisponivel" };
    } finally {
      clearTimeout(timer);
    }
  }

  async function callback(request) {
    if (!g) return fail("indisponivel");
    const url = new URL(request.url);
    const sealed = unseal(readCookie(request, stateCookieName(config)));
    if (url.searchParams.get("error")) {                       // pessoa cancelou ou o Google recusou
      log("google_cancelled");
      return fail("cancelado");
    }
    const state = url.searchParams.get("state") || "";
    const code = url.searchParams.get("code") || "";
    if (!sealed || typeof sealed.s !== "string" || typeof sealed.n !== "string" || typeof sealed.v !== "string"
      || !Number.isFinite(sealed.e) || sealed.e < now()) {
      log("google_state_missing");
      return fail("expirado");
    }
    const a = Buffer.from(state);
    const b = Buffer.from(sealed.s);
    if (a.length !== b.length || !timingSafeEqual(a, b) || !code || code.length > 2048) {
      log("google_state_mismatch");
      return fail("expirado");
    }
    const tokens = await exchange(code, sealed.v);
    if (tokens.error) {
      log("google_exchange_failed");
      return fail(tokens.error);
    }
    const done = await performLogin(request, { path: "/auth/google", body: { idToken: tokens.idToken, nonce: sealed.n } });
    if (done.response) {
      const reason = done.status === 429 ? "limite" : done.status === 401 ? "conta"
        : done.status === 503 || done.response.status === 503 ? "indisponivel" : "falhou";
      log("google_login_failed", { reason });
      return fail(reason);
    }
    log("google_login_ok");
    return landing("/app", [...done.cookies, cookie(config, "", 0)]);
  }

  return { status, start, callback };
}
