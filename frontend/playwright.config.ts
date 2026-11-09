// E2E da Etapa 6.1: navegador real + Next (build integrado) + FastAPI real (sem dublês).
// Uso: PRAZOAI_TEST_PYTHON=/caminho/python npm run test:e2e
// Navegador: o Chromium do Playwright (`npx playwright install chromium`) ou, se definido,
// PLAYWRIGHT_CHROMIUM_EXECUTABLE (ambientes sem acesso ao CDN do Playwright).
import { defineConfig } from "@playwright/test";

const PORT = Number(process.env.PRAZOAI_E2E_PORT || 3100);
const BACKEND_PORT = Number(process.env.PRAZOAI_E2E_BACKEND_PORT || 18900);
export const E2E = { origin: `http://localhost:${PORT}`, backend: `http://127.0.0.1:${BACKEND_PORT}` };

const appEnv = {
  NEXT_PUBLIC_PRAZOAI_MODE: "integrated",
  PRAZOAI_DIST_DIR: ".next-e2e",
  PRAZOAI_APP_ENV: "test",
  PRAZOAI_APP_ORIGIN: E2E.origin,
  PRAZOAI_COOKIE_INSECURE_LOCAL: "true",
  PRAZOAI_BACKEND_URL: E2E.backend,
  // Backend com access token de 60 s; margem de 59 s → quase toda requisição renova (exercita a rotação).
  PRAZOAI_ACCESS_REFRESH_SKEW_SECONDS: "59",
  NEXT_TELEMETRY_DISABLED: "1",
};

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  reporter: [["list"]],
  globalSetup: "./e2e/global-setup.mjs",
  globalTeardown: "./e2e/global-teardown.mjs",
  use: {
    baseURL: E2E.origin,
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE, args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"] }
      : {},
  },
  webServer: {
    // PRAZOAI_E2E_SKIP_BUILD=1 reaproveita um build integrado já gerado em .next-e2e.
    command: process.env.PRAZOAI_E2E_SKIP_BUILD === "1"
      ? `npx next start -p ${PORT}`
      : `npx next build && npx next start -p ${PORT}`,
    url: `${E2E.origin}/login`,
    timeout: 240_000,
    reuseExistingServer: false,
    env: { ...process.env, ...appEnv } as Record<string, string>,
  },
});
