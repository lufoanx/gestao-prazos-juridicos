// Regras de forma da recuperação de senha, COMPARTILHADAS pelo BFF (E4) e pelas telas (E5).
// Espelham o backend (app/schemas/auth.py): e-mail até 254 pontos de código depois de remover
// espaços externos; senha 8..128 e não só espaços; token opaco 16..256. São sempre um SUBCONJUNTO
// das recusas do backend: nunca aceitam o que ele recusaria por tamanho/forma, nem recusam o que
// ele aceitaria por regra que não exista lá (o formato completo do e-mail é do backend).

export const EMAIL_MAX = 254;
export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 128;
export const TOKEN_MIN = 16;
export const TOKEN_MAX = 256;
const CONTROL = /[\u0000-\u001f\u007f]/;

// Comprimento em pontos de código, como `len()` no Python (o `.length` do JS conta unidades UTF-16).
export const cpLength = (value) => [...value].length;

const exactKeys = (value, keys) => {
  const got = Object.keys(value);
  return got.length === keys.length && keys.every((k) => Object.hasOwn(value, k));
};

/** @returns {string | null} motivo genérico (sem o valor) ou null se o e-mail tem forma aceitável */
export function emailProblem(email) {
  if (typeof email !== "string") return "E-mail inválido.";
  const trimmed = email.trim();
  if (!trimmed || cpLength(trimmed) > EMAIL_MAX || CONTROL.test(trimmed) || !trimmed.includes("@")) return "E-mail inválido.";
  return null;
}

/** @returns {string | null} */
export function passwordProblem(password) {
  if (typeof password !== "string" || cpLength(password) < PASSWORD_MIN || cpLength(password) > PASSWORD_MAX
      || !password.trim()) {
    return `A senha deve ter entre ${PASSWORD_MIN} e ${PASSWORD_MAX} caracteres.`;
  }
  return null;
}

/** @returns {string | null} */
export function tokenProblem(token) {
  if (typeof token !== "string" || cpLength(token) < TOKEN_MIN || cpLength(token) > TOKEN_MAX) return "Link de redefinição inválido.";
  return null;
}

/** Corpo exato de /bff/public/password/forgot. @returns {string | null} */
export function validateForgotBody(value) {
  if (!value || !exactKeys(value, ["email"])) return "Envie somente o e-mail.";
  return emailProblem(value.email);
}

/** Corpo exato de /bff/public/password/reset. @returns {string | null} */
export function validateResetBody(value) {
  if (!value || !exactKeys(value, ["token", "newPassword"])) return "Envie somente o token e a nova senha.";
  return tokenProblem(value.token) ?? passwordProblem(value.newPassword);
}
