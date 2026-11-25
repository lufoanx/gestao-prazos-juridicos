// Esquema das sessões do BFF (PostgreSQL): comando EXPLÍCITO, nunca executado no startup.
//
//   npm run bff:sessions -- check     # somente leitura: destino (sem credenciais) e versão do esquema
//   npm run bff:sessions -- migrate   # aplica migrations pendentes (papel DONO do esquema prazoai_bff)
//
// Lê PRAZOAI_BFF_DATABASE_URL (ou PRAZOAI_BFF_MIGRATION_DATABASE_URL, quando o papel de migração é
// diferente do papel da aplicação). Em `migrate`, PRAZOAI_BFF_CONFIRM_TARGET deve repetir
// "host:porta/banco" do destino — proteção contra migrar o banco errado. Nada de credenciais na saída.
// Códigos de saída: 0 ok; 2 configuração; 4 esquema ausente/desatualizado (check); 5 banco indisponível.
import pg from "pg";
import { BFF_SCHEMA_VERSION, currentVersion, migrate } from "../src/server/bff/session-schema.mjs";

function target(raw) {
  const u = new URL(raw);
  return `${u.hostname}:${u.port || 5432}${u.pathname}`;
}

async function main(argv) {
  const cmd = argv[0];
  if (!["check", "migrate"].includes(cmd)) {
    console.error("uso: npm run bff:sessions -- check|migrate");
    return 2;
  }
  const raw = process.env.PRAZOAI_BFF_MIGRATION_DATABASE_URL || process.env.PRAZOAI_BFF_DATABASE_URL;
  if (!raw) { console.error("PRAZOAI_BFF_DATABASE_URL não definida."); return 2; }
  let dest;
  try { dest = target(raw); } catch { console.error("URL do banco inválida."); return 2; }
  if (cmd === "migrate" && process.env.PRAZOAI_BFF_CONFIRM_TARGET !== dest) {
    console.error(`Confirme o destino: PRAZOAI_BFF_CONFIRM_TARGET=${dest}`);
    return 2;
  }
  const client = new pg.Client({ connectionString: raw, application_name: "prazoai-bff-migrations",
    connectionTimeoutMillis: 5000, options: "-c statement_timeout=30000 -c lock_timeout=5000" });
  try {
    await client.connect();
  } catch (e) {
    console.error(`Falha ao conectar em ${dest}: ${e?.code || "erro"}`);
    return 5;
  }
  try {
    if (cmd === "check") {
      const v = await currentVersion(client);
      console.log(`destino: ${dest}`);
      console.log(`versão do esquema prazoai_bff: ${v ?? "ausente"} (esperada ${BFF_SCHEMA_VERSION})`);
      return v === BFF_SCHEMA_VERSION ? 0 : 4;
    }
    const r = await migrate(client);
    console.log(`destino: ${dest}`);
    console.log(`esquema prazoai_bff: ${r.from} -> ${r.to}`);
    return 0;
  } catch (e) {
    console.error(`Falha: ${e?.code || (e instanceof Error ? e.message : "erro")}`);
    return 5;
  } finally {
    await client.end().catch(() => {});
  }
}

process.exitCode = await main(process.argv.slice(2));
