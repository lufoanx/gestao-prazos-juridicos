// Provedor OpenID Connect de TESTE que imita o Google no E2E (só loopback, chave RSA por execução).
// /authorize devolve na hora ao redirect_uri (como se a pessoa tivesse escolhido a conta), /token troca o
// código conferindo client_secret e PKCE, /jwks publica a chave pública. /__next define a próxima identidade
// (ou "cancelar"). Nada disto existe na aplicação: em produção o BFF e o backend recusam estes endereços.
import { createHash, createSign, generateKeyPairSync, randomBytes } from "node:crypto";
import { createServer } from "node:http";

export async function startGoogleMock({ port, clientId, clientSecret }) {
  const issuer = `http://127.0.0.1:${port}`;
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const kid = randomBytes(8).toString("hex");
  const jwk = { ...publicKey.export({ format: "jwk" }), kid, alg: "RS256", use: "sig" };
  const codes = new Map();
  let next = null;
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const sign = (claims) => {
    const head = `${b64({ alg: "RS256", typ: "JWT", kid })}.${b64(claims)}`;
    return `${head}.${createSign("RSA-SHA256").update(head).sign(privateKey).toString("base64url")}`;
  };
  const json = (res, status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, issuer);
    if (url.pathname === "/__next") {
      next = url.searchParams.get("cancel") ? { cancel: true }
        : { email: url.searchParams.get("email"), name: url.searchParams.get("name") || undefined };
      return json(res, 200, { ok: true });
    }
    if (url.pathname === "/jwks") return json(res, 200, { keys: [jwk] });
    if (url.pathname === "/authorize") {
      const p = url.searchParams;
      const back = new URL(p.get("redirect_uri"));
      if (p.get("client_id") !== clientId || p.get("code_challenge_method") !== "S256") return json(res, 400, { error: "invalid_request" });
      const who = next; next = null;
      back.searchParams.set("state", p.get("state"));
      if (!who || who.cancel) back.searchParams.set("error", "access_denied");
      else {
        const code = randomBytes(16).toString("hex");
        codes.set(code, { who, nonce: p.get("nonce"), challenge: p.get("code_challenge"), redirect: p.get("redirect_uri") });
        back.searchParams.set("code", code);
      }
      res.writeHead(302, { location: back.toString() });
      return res.end();
    }
    if (url.pathname === "/token" && req.method === "POST") {
      let raw = "";
      for await (const c of req) raw += c;
      const f = new URLSearchParams(raw);
      const entry = codes.get(f.get("code"));
      codes.delete(f.get("code"));
      const pkce = entry && createHash("sha256").update(f.get("code_verifier") || "").digest("base64url") === entry.challenge;
      if (!entry || !pkce || f.get("client_id") !== clientId || f.get("client_secret") !== clientSecret
          || f.get("redirect_uri") !== entry.redirect) return json(res, 400, { error: "invalid_grant" });
      const now = Math.floor(Date.now() / 1000);
      const sub = createHash("sha256").update(entry.who.email).digest("hex").slice(0, 21);
      const idToken = sign({ iss: issuer, aud: clientId, sub, email: entry.who.email, email_verified: true,
        name: entry.who.name, nonce: entry.nonce, iat: now, exp: now + 300 });
      return json(res, 200, { id_token: idToken, access_token: "teste", token_type: "Bearer", expires_in: 300 });
    }
    json(res, 404, { error: "not_found" });
  });
  await new Promise((r) => server.listen(port, "127.0.0.1", r));
  return { issuer, server };
}
