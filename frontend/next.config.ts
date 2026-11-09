import type { NextConfig } from "next";

// PRAZOAI_DIST_DIR permite builds isolados (ex.: E2E em modo integrado) sem sobrescrever .next.
const config: NextConfig = {
  poweredByHeader: false,
  distDir: process.env.PRAZOAI_DIST_DIR || ".next",
};
export default config;
