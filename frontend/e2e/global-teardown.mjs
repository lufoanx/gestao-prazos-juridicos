import { readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

export default async function globalTeardown() {
  const file = fileURLToPath(new URL("./.backend.pid", import.meta.url));
  try { process.kill(Number(readFileSync(file, "utf8")), "SIGTERM"); } catch { /* já encerrado */ }
  try { rmSync(file); } catch { /* ok */ }
  await new Promise((r) => (globalThis.__prazoaiE2EProxy ? globalThis.__prazoaiE2EProxy.close(r) : r()));
  await globalThis.__prazoaiE2EEdge?.close();
}
