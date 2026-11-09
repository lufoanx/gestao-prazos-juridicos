// Sobe o FastAPI real para o E2E (ambiente de teste, sem dados reais). Guarda o PID para encerrar.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export default async function globalSetup() {
  const port = Number(process.env.PRAZOAI_E2E_BACKEND_PORT || 18900);
  const python = process.env.PRAZOAI_TEST_PYTHON || "python3";
  const proc = spawn(python, ["-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", String(port), "--no-proxy-headers"], {
    cwd: fileURLToPath(new URL("../../backend", import.meta.url)),
    env: { ...process.env, ENVIRONMENT: "test", AUTH_JWT_SECRET: randomBytes(32).toString("hex"),
      AUTH_ACCESS_TOKEN_TTL_SECONDS: "60", AUTH_REGISTER_MAX_REQUESTS: "200", LOG_LEVEL: "WARNING" },
    stdio: "ignore",
    detached: false,
  });
  writeFileSync(fileURLToPath(new URL("./.backend.pid", import.meta.url)), String(proc.pid));
  for (let i = 0; i < 150; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/api/v1/health`)).ok) return; } catch { /* subindo */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("backend do E2E não subiu");
}
