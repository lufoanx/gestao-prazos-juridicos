import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

// Salvaguarda de contrato: garante que TODA função/const declarada em cada
// src/lib/*.d.mts realmente existe na implementação .mjs correspondente.
// Pega divergências declaração↔implementação na SUPERFÍCIE de exportação
// (renome/remoção de export) sem exigir checkJs global.
const here = dirname(fileURLToPath(import.meta.url));
const libDir = join(here, "..", "src", "lib");

const decls = readdirSync(libDir).filter((f) => f.endsWith(".d.mts"));

for (const d of decls) {
  const base = d.replace(/\.d\.mts$/, "");
  test(`contrato: ${base}.d.mts ↔ ${base}.mjs`, async () => {
    const dts = readFileSync(join(libDir, d), "utf8");
    const fnNames = [...dts.matchAll(/export function ([A-Za-z0-9_]+)/g)].map((m) => m[1]);
    const constNames = [...dts.matchAll(/export const ([A-Za-z0-9_]+)/g)].map((m) => m[1]);
   const mod = await import(pathToFileURL(join(libDir, `${base}.mjs`)).href);
    for (const name of fnNames) {
      assert.equal(typeof mod[name], "function", `${base}.mjs deve exportar a função ${name}`);
    }
    for (const name of constNames) {
      assert.ok(name in mod, `${base}.mjs deve exportar a const ${name}`);
      assert.notEqual(mod[name], undefined, `${base}.mjs: const ${name} não pode ser undefined`);
    }
  });
}
