// Identificadores DEMONSTRATIVOS estáveis.
// Objetivo: cada conta/escritório tem um id próprio e determinístico (derivado
// do e-mail / nome), para que os dados persistidos não se misturem entre contas
// no mesmo navegador. Em produção os ids viriam do backend.

/** Hash FNV-1a 32 bits → base36 (curto e estável). Não é criptográfico. */
export function stableHash(str) {
  let h = 0x811c9dc5;
  const s = String(str);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/** Id de usuário derivado do e-mail (mesmo e-mail → mesmo id). */
export function userIdFromEmail(email) {
  return "u_" + stableHash("user:" + String(email || "").trim().toLowerCase());
}

/** Id de escritório derivado do dono + nome (estável para os mesmos dados). */
export function officeIdFor(ownerId, name) {
  return "office_" + stableHash("office:" + String(ownerId) + ":" + String(name || "").trim().toLowerCase());
}

let counter = 0;
/** Id único para registros (prazos, comentários, anexos, eventos). */
export function newId(prefix = "rec") {
  counter += 1;
  const rand = Math.floor(Math.random() * 1e9).toString(36);
  return `${prefix}_${Date.now().toString(36)}_${counter.toString(36)}${rand}`;
}
