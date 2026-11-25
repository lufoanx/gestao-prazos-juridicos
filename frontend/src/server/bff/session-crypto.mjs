// Proteção em repouso das sessões do BFF no armazenamento compartilhado (somente servidor).
//
// - O identificador da sessão (valor do cookie) e o identificador do navegador NUNCA são gravados:
//   só o SHA-256 deles. Quem lê o banco não obtém um cookie utilizável.
// - Access e refresh tokens do backend são cifrados com AES-256-GCM. O texto associado (AAD) amarra
//   cada cifra ao campo e à linha (hash do id), então trocar cifras entre linhas ou campos falha.
// - Formato: [versão 0x01][impressão da chave, 8 bytes][IV, 12][tag, 16][cifra].
// - Rotação: a chave atual cifra; a anterior (opcional) só decifra.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const VERSION = 0x01;
const FP_LEN = 8;
const IV_LEN = 12;
const TAG_LEN = 16;

export class SessionKeyError extends Error {}
export class SessionDecryptError extends Error {}

/** Chave de 32 bytes em base64url (ou base64). Mensagens nunca contêm o valor recebido. */
export function parseSessionKey(raw, name) {
  if (!raw) throw new SessionKeyError(`${name} é obrigatória.`);
  const text = String(raw).trim();
  if (!/^[A-Za-z0-9_\-+/]+=*$/.test(text)) throw new SessionKeyError(`${name} deve estar em base64url.`);
  const key = Buffer.from(text.replace(/\+/g, "-").replace(/\//g, "_"), "base64url");
  if (key.length !== 32) throw new SessionKeyError(`${name} deve decodificar para exatamente 32 bytes.`);
  if (new Set(key).size < 8) throw new SessionKeyError(`${name} não parece aleatória.`);
  return key;
}

export function keyFingerprint(key) {
  return createHash("sha256").update("prazoai-bff-key:").update(key).digest().subarray(0, FP_LEN);
}

export function hashId(value) {
  return createHash("sha256").update(String(value), "utf8").digest();
}

function aad(field, rowHash) {
  return Buffer.concat([Buffer.from(`prazoai-bff:v1:${field}:`, "utf8"), rowHash]);
}

/** @param {{ current: Buffer, previous?: Buffer | null }} keys */
export function createSessionCipher(keys) {
  const current = { key: keys.current, fp: keyFingerprint(keys.current) };
  const all = [current];
  if (keys.previous) all.push({ key: keys.previous, fp: keyFingerprint(keys.previous) });

  return {
    encrypt(field, rowHash, plaintext) {
      const iv = randomBytes(IV_LEN);
      const c = createCipheriv("aes-256-gcm", current.key, iv);
      c.setAAD(aad(field, rowHash));
      const ct = Buffer.concat([c.update(String(plaintext), "utf8"), c.final()]);
      return Buffer.concat([Buffer.from([VERSION]), current.fp, iv, c.getAuthTag(), ct]);
    },
    decrypt(field, rowHash, blob) {
      const buf = Buffer.from(blob);
      if (buf.length < 1 + FP_LEN + IV_LEN + TAG_LEN || buf[0] !== VERSION) throw new SessionDecryptError("formato");
      const fp = buf.subarray(1, 1 + FP_LEN);
      const entry = all.find((k) => k.fp.equals(fp));
      if (!entry) throw new SessionDecryptError("chave desconhecida");
      const iv = buf.subarray(1 + FP_LEN, 1 + FP_LEN + IV_LEN);
      const tag = buf.subarray(1 + FP_LEN + IV_LEN, 1 + FP_LEN + IV_LEN + TAG_LEN);
      const ct = buf.subarray(1 + FP_LEN + IV_LEN + TAG_LEN);
      try {
        const d = createDecipheriv("aes-256-gcm", entry.key, iv);
        d.setAAD(aad(field, rowHash));
        d.setAuthTag(tag);
        return Buffer.concat([d.update(ct), d.final()]).toString("utf8");
      } catch {
        throw new SessionDecryptError("autenticação");
      }
    },
  };
}
