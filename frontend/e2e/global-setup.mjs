// Sobe o FastAPI real para o E2E (ambiente de teste, sem dados reais) e, entre o BFF e o
// FastAPI, um proxy HTTP de TESTE que só repassa as requisições — exceto quando o teste pede para
// segurar o próximo login (para reproduzir de forma determinística o login pendente × logout).
// As rotas de controle /__e2e/* existem somente neste proxy de teste, não na aplicação.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer, request as httpRequest } from "node:http";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export default async function globalSetup() {
  const port = Number(process.env.PRAZOAI_E2E_BACKEND_PORT || 18900);
  const proxyPort = port + 1;
  const python = process.env.PRAZOAI_TEST_PYTHON || "python3";
  const proc = spawn(python, ["-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", String(port), "--no-proxy-headers"], {
    cwd: fileURLToPath(new URL("../../backend", import.meta.url)),
    env: { ...process.env, ENVIRONMENT: "test", AUTH_JWT_SECRET: randomBytes(32).toString("hex"),
      AUTH_ACCESS_TOKEN_TTL_SECONDS: "60", AUTH_REGISTER_MAX_REQUESTS: "200", LOG_LEVEL: "WARNING" },
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

  for (let i = 0; i < 150; i++) {
    try { if ((await fetch(`http://127.0.0.1:${proxyPort}/api/v1/health`)).ok) return; } catch { /* subindo */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("backend do E2E não subiu");
}
