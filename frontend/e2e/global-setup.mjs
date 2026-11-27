// Sobe o FastAPI real para o E2E (ambiente de teste, sem dados reais) e, entre o BFF e o
// FastAPI, um proxy HTTP de TESTE que só repassa as requisições — exceto quando o teste pede para
// segurar o próximo login (para reproduzir de forma determinística o login pendente × logout).
// As rotas de controle /__e2e/* existem somente neste proxy de teste, não na aplicação.
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer, request as httpRequest } from "node:http";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { startEdgeProxy } from "./edge-proxy.mjs";
import { startGoogleMock } from "./google-mock.mjs";
import pg from "pg";
import { mailpitFromEnv } from "../tests/helpers/mailpit.mjs";
import { migrate } from "../src/server/bff/session-schema.mjs";

export default async function globalSetup() {
  // Sessões compartilhadas do BFF (doc 27): esquema prazoai_bff recriado num banco DESCARTÁVEL (*_test).
  const bffDb = process.env.PRAZOAI_E2E_BFF_DATABASE_URL;
  if (bffDb) {
    if (!/(_test$|^prazoai_test)/.test(new URL(bffDb).pathname.slice(1))) throw new Error("banco das sessões do E2E deve ser descartável");
    const c = new pg.Client({ connectionString: bffDb });
    await c.connect();
    try { await c.query("DROP SCHEMA IF EXISTS prazoai_bff CASCADE"); await migrate(c); } finally { await c.end(); }
  }
  const port = Number(process.env.PRAZOAI_E2E_BACKEND_PORT || 18900);
  const proxyPort = port + 1;
  const python = process.env.PRAZOAI_TEST_PYTHON || "python3";
  // E5: recuperação de senha REAL quando há capturador SMTP local (Mailpit, só loopback; mesma
  // exceção explícita de SMTP sem TLS da E1/E3, restrita a ENVIRONMENT=test). Sem capturador, o
  // backend fica com o padrão `EMAIL_TRANSPORT=disabled` e os cenários que dependem de e-mail são
  // pulados — ou FALHAM se PRAZOAI_REQUIRE_MAILPIT_TESTS=1 (CI).
  const mailpit = mailpitFromEnv();
  if (!mailpit && process.env.PRAZOAI_REQUIRE_MAILPIT_TESTS === "1") throw new Error("capturador SMTP obrigatório e não configurado");
  const appOrigin = `http://localhost:${Number(process.env.PRAZOAI_E2E_PORT || 3100)}`;
  const recoveryEnv = mailpit ? {
    EMAIL_TRANSPORT: "smtp", PUBLIC_APP_ORIGIN: appOrigin, EMAIL_FROM: "PrazoAI <nao-responda@exemplo.com>",
    SMTP_HOST: mailpit.smtp.host, SMTP_PORT: mailpit.smtp.port, SMTP_SECURITY: "none", SMTP_ALLOW_INSECURE_LOCAL: "true",
  } : { EMAIL_TRANSPORT: "disabled" };
  if (mailpit) await mailpit.ready();
  // Doc 28: PDF das intimações em Azure Blob — Azurite LOCAL com container próprio desta execução.
  // A tela integrada de registro envia o PDF, então o E2E exige STORAGE=postgres e o Azurite.
  const azurite = process.env.PRAZOAI_E2E_AZURITE_CONNECTION_STRING;
  if (!azurite || process.env.STORAGE !== "postgres") {
    throw new Error("E2E exige STORAGE=postgres e PRAZOAI_E2E_AZURITE_CONNECTION_STRING (Azurite local; doc 28)");
  }
  if (!(azurite.includes("devstoreaccount1") && azurite.includes("127.0.0.1"))) throw new Error("somente Azurite local");
  const filesEnv = { FILE_STORAGE: "azure_blob", AZURE_STORAGE_CONNECTION_STRING: azurite,
    AZURE_STORAGE_CONTAINER: `e2e${randomBytes(8).toString("hex")}` };
  const backendDir = fileURLToPath(new URL("../../backend", import.meta.url));
  const created = spawnSync(python, ["-m", "app.files", "create-container"], { cwd: backendDir,
    env: { ...process.env, ENVIRONMENT: "test", ...filesEnv }, encoding: "utf8" });
  if (created.status !== 0) throw new Error("não foi possível criar o container privado no Azurite");
  // Entrar com Google: provedor OIDC de teste (porta do backend + 2); o backend confere as assinaturas
  // com a JWKS dele — exceção GOOGLE_JWKS_URL/GOOGLE_ISSUER só aceita fora de produção.
  const google = await startGoogleMock({ port: port + 2, clientId: process.env.PRAZOAI_E2E_GOOGLE_CLIENT_ID,
    clientSecret: process.env.PRAZOAI_E2E_GOOGLE_CLIENT_SECRET });
  globalThis.__prazoaiE2EGoogle = google.server;
  const googleEnv = { GOOGLE_CLIENT_ID: process.env.PRAZOAI_E2E_GOOGLE_CLIENT_ID, GOOGLE_JWKS_URL: `${google.issuer}/jwks`,
    GOOGLE_ISSUER: google.issuer };
  const proc = spawn(python, ["-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", String(port), "--no-proxy-headers"], {
    cwd: fileURLToPath(new URL("../../backend", import.meta.url)),
    env: { ...process.env, ENVIRONMENT: "test", AUTH_JWT_SECRET: randomBytes(32).toString("hex"),
      AUTH_ACCESS_TOKEN_TTL_SECONDS: "60", AUTH_REGISTER_MAX_REQUESTS: "200", LOG_LEVEL: "WARNING",
      // Confiança no IP encaminhado pelo BFF, SOMENTE no E2E (segredo gerado por execução).
      // Limites de convite (ORG_INVITE_ACCEPT_MAX/LOOKUP_MAX) NÃO são alterados.
      TRUSTED_PROXY_SECRET: process.env.PRAZOAI_E2E_PROXY_SECRET, ...recoveryEnv, ...filesEnv, ...googleEnv },
    stdio: "ignore",
  });
  writeFileSync(fileURLToPath(new URL("./.backend.pid", import.meta.url)), String(proc.pid));

  // Segura UMA única próxima chamada ao caminho pedido (one-shot); libera tudo em /__e2e/release.
  const holds = new Set();
  const held = [];
  const proxy = createServer((req, res) => {
    if (req.url?.startsWith("/__e2e/")) {
      const url = new URL(req.url, "http://x");
      if (url.pathname === "/__e2e/hold") holds.add(url.searchParams.get("path"));
      if (url.pathname === "/__e2e/release") { holds.clear(); held.splice(0).forEach((go) => go()); }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ held: held.length }));
      return;
    }
    const forward = () => {
      const upstream = httpRequest({ host: "127.0.0.1", port, path: req.url, method: req.method, headers: req.headers }, (up) => {
        res.writeHead(up.statusCode || 502, up.headers);
        up.pipe(res);
      });
      upstream.on("error", () => { if (!res.headersSent) res.writeHead(502); res.end(); });
      req.pipe(upstream);
    };
    if (holds.has(req.url)) { holds.delete(req.url); held.push(forward); }
    else forward();
  });
  await new Promise((r) => proxy.listen(proxyPort, "127.0.0.1", r));
  globalThis.__prazoaiE2EProxy = proxy;

  // Proxy de BORDA simulado diante do Next: única camada que define o IP confiável do cliente.
  const appPort = Number(process.env.PRAZOAI_E2E_PORT || 3100);
  globalThis.__prazoaiE2EEdge = await startEdgeProxy({ listenPort: appPort, targetPort: appPort + 1 });

  for (let i = 0; i < 150; i++) {
    try { if ((await fetch(`http://127.0.0.1:${proxyPort}/api/v1/health`)).ok) return; } catch { /* subindo */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("backend do E2E não subiu");
}
