// E2E da Etapa 6.1: navegador real + Next (build integrado) + FastAPI real (sem dublês).
// Uso: PRAZOAI_TEST_PYTHON=/caminho/python npm run test:e2e
// Navegador: o Chromium do Playwright (`npx playwright install chromium`) ou, se definido,
// PLAYWRIGHT_CHROMIUM_EXECUTABLE (ambientes sem acesso ao CDN do Playwright).
import { randomBytes } from "node:crypto";
import { defineConfig } from "@playwright/test";

// Diagnósticos sem segredos (E5): falhas podem ocorrer em telas com campos de senha e depois de
// abrir links com token no fragmento. Por isso NÃO há trace, screenshot, vídeo nem o "error context"
// com o snapshot ARIA da página (que pode conter valores de campos); o reporter é só `list` e as
// verificações sensíveis dos specs usam mensagens sanitizadas (tests/helpers/sensitive.mjs).
// As falhas continuam visíveis: mensagem sanitizada, arquivo e linha do teste.
process.env.PLAYWRIGHT_NO_COPY_PROMPT = "1";

// Porta PÚBLICA do E2E = proxy de borda simulado (e2e/edge-proxy.mjs); o Next escuta em PORT+1.
const PORT = Number(process.env.PRAZOAI_E2E_PORT || 3100);
const NEXT_PORT = PORT + 1;
// Segredo BFF↔backend gerado POR EXECUÇÃO, só no servidor (nunca NEXT_PUBLIC_*, nunca no navegador).
// Herdado pelo backend do E2E (global-setup) e pelo Next (webServer); os workers herdam o mesmo valor.
process.env.PRAZOAI_E2E_PROXY_SECRET ??= randomBytes(32).toString("hex");
// Sessões do BFF COMPARTILHADAS (doc 27): com PRAZOAI_E2E_BFF_DATABASE_URL (PostgreSQL descartável), o
// Next usa o armazenamento no PostgreSQL com chave gerada por execução; o global-setup recria o esquema.
// Sem a variável, as sessões ficam em memória (ou o E2E FALHA com PRAZOAI_REQUIRE_BFF_PG_TESTS=1).
process.env.PRAZOAI_E2E_BFF_SESSION_KEY ??= randomBytes(32).toString("base64url");
const sharedSessions = process.env.PRAZOAI_E2E_BFF_DATABASE_URL
  ? { PRAZOAI_BFF_SESSION_STORE: "postgres", PRAZOAI_BFF_DATABASE_URL: process.env.PRAZOAI_E2E_BFF_DATABASE_URL,
      PRAZOAI_BFF_SESSION_KEY: process.env.PRAZOAI_E2E_BFF_SESSION_KEY }
  : {};
if (!process.env.PRAZOAI_E2E_BFF_DATABASE_URL && process.env.PRAZOAI_REQUIRE_BFF_PG_TESTS === "1") {
  throw new Error("PRAZOAI_REQUIRE_BFF_PG_TESTS=1 exige PRAZOAI_E2E_BFF_DATABASE_URL");
}
const BACKEND_PORT = Number(process.env.PRAZOAI_E2E_BACKEND_PORT || 18900);
// O BFF fala com o proxy de TESTE (porta do backend + 1), que repassa ao FastAPI real.
// Entrar com Google no E2E: provedor OIDC de TESTE (e2e/google-mock.mjs) na porta do backend + 2,
// com ID e segredo do cliente gerados por execução (nunca valores reais).
process.env.PRAZOAI_E2E_GOOGLE_CLIENT_ID ??= `e2e-${randomBytes(6).toString("hex")}.apps.googleusercontent.com`;
process.env.PRAZOAI_E2E_GOOGLE_CLIENT_SECRET ??= randomBytes(24).toString("base64url");
const GOOGLE_MOCK = `http://127.0.0.1:${BACKEND_PORT + 2}`;
export const E2E = {
  origin: `http://localhost:${PORT}`,
  google: GOOGLE_MOCK,
  backend: `http://127.0.0.1:${BACKEND_PORT + 1}`,
  control: `http://127.0.0.1:${BACKEND_PORT + 1}/__e2e`,
};

const appEnv = {
  NEXT_PUBLIC_PRAZOAI_MODE: "integrated",
  PRAZOAI_DIST_DIR: ".next-e2e",
  PRAZOAI_APP_ENV: "test",
  PRAZOAI_APP_ORIGIN: E2E.origin,
  PRAZOAI_COOKIE_INSECURE_LOCAL: "true",
  PRAZOAI_BACKEND_URL: E2E.backend,
  // Backend com access token de 60 s; margem de 59 s → quase toda requisição renova (exercita a rotação).
  PRAZOAI_ACCESS_REFRESH_SKEW_SECONDS: "59",
  // IP confiável SOMENTE no E2E: o BFF lê o cabeçalho que o proxy de borda simulado sobrescreve.
  PRAZOAI_PROXY_SECRET: process.env.PRAZOAI_E2E_PROXY_SECRET,
  PRAZOAI_TRUSTED_CLIENT_IP_HEADER: "x-prazoai-e2e-client-ip",
  NEXT_TELEMETRY_DISABLED: "1",
  PRAZOAI_GOOGLE_CLIENT_ID: process.env.PRAZOAI_E2E_GOOGLE_CLIENT_ID,
  PRAZOAI_GOOGLE_CLIENT_SECRET: process.env.PRAZOAI_E2E_GOOGLE_CLIENT_SECRET,
  PRAZOAI_GOOGLE_AUTHORIZE_URL: `${GOOGLE_MOCK}/authorize`,
  PRAZOAI_GOOGLE_TOKEN_URL: `${GOOGLE_MOCK}/token`,
  ...sharedSessions,
};

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,                       // nada de novas tentativas para "zerar" limitadores
  timeout: 60_000,
  reporter: [["list"]],
  globalSetup: "./e2e/global-setup.mjs",
  globalTeardown: "./e2e/global-teardown.mjs",
  use: {
    baseURL: E2E.origin,
    trace: "off",
    screenshot: "off",
    video: "off",
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE, args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"] }
      : {},
  },
  webServer: {
    // PRAZOAI_E2E_SKIP_BUILD=1 reaproveita um build integrado já gerado em .next-e2e.
    command: process.env.PRAZOAI_E2E_SKIP_BUILD === "1"
      ? `npx next start -p ${NEXT_PORT}`
      : `npx next build && npx next start -p ${NEXT_PORT}`,
    url: `http://localhost:${NEXT_PORT}/login`,
    timeout: 240_000,
    reuseExistingServer: false,
    env: { ...process.env, ...appEnv } as Record<string, string>,
    stdout: "ignore",                 // não registrar a saída do servidor nos artefatos
  },
});
