// Formato de e-mail aceito nos formulários (checagem rápida no navegador; a regra oficial é a do backend,
// `backend/app/schemas/auth.py`). Rótulos do domínio sem ponto, separados por um ponto: tempo linear.
export const EMAIL_RE = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/;

export function isEmailFormat(value: string): boolean {
  return EMAIL_RE.test(value);
}
