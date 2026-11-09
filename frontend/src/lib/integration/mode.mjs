// Modo da aplicação: "demo" (dados locais demonstrativos) ou "integrated" (BFF + FastAPI).
// Escolhido EXPLICITAMENTE por configuração; nunca alternado automaticamente por falha.
// Sem valor definido → "demo" (preserva o protótipo publicado; o modo integrado exige o BFF).
export const MODES = Object.freeze(["demo", "integrated"]);

export function resolveMode(value) {
  if (value === undefined || value === "") return "demo";
  if (!MODES.includes(value)) throw new Error(`NEXT_PUBLIC_PRAZOAI_MODE inválido: ${value}`);
  return value;
}

export function isIntegratedMode(env = process.env) {
  return resolveMode(env.NEXT_PUBLIC_PRAZOAI_MODE) === "integrated";
}

/** Modo no navegador (inlined pelo Next em build). */
export const APP_MODE = resolveMode(process.env.NEXT_PUBLIC_PRAZOAI_MODE);
