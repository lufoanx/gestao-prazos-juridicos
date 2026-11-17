// BFF — rotas PÚBLICAS da recuperação de senha (E4 do doc 21).
//
//   GET  /bff/public/password/status → GET  /api/v1/auth/password-recovery/status
//   POST /bff/public/password/forgot → POST /api/v1/auth/forgot-password   corpo exato { email }
//   POST /bff/public/password/reset  → POST /api/v1/auth/reset-password    corpo exato { token, newPassword }
//
// Regras (todas as três rotas):
// - destino, método e caminho FIXOS (tabela abaixo); query string do cliente é recusada; cabeçalhos
//   ao backend são montados do zero por `callBackend` (nada de cookie, Authorization ou X-Forwarded-*);
// - cabeçalho próprio de CSRF sempre; Origin igual à origem configurada nas mutações (POST);
// - corpo exato e validado ANTES de qualquer chamada ao backend (subconjunto das regras do backend:
//   o BFF nunca aceita o que o backend recusaria por tamanho/forma, nem recusa o que ele aceitaria
//   por regra que não exista lá);
// - NENHUM acesso a cookies ou ao armazenamento de sessões: não lê, cria, renova nem apaga sessão;
//   uma sessão existente fica intacta em sucesso, erro ou timeout. A revogação feita pelo reset no
//   backend é descoberta pela sessão BFF no fluxo normal (401 no próximo uso autenticado);
// - respostas sempre `no-store` e com corpo REDUZIDO a formas conhecidas (nada interno, nada de SMTP);
// - nenhuma repetição automática; timeout depois do envio = resultado DESCONHECIDO (504, outcome
//   "unknown"), nunca "falhou";
// - nada de token, senha, e-mail ou corpo em logs.

const ROUTES = Object.freeze({
  status: Object.freeze({ method: "GET", path: "/auth/password-recovery/status" }),
  forgot: Object.freeze({ method: "POST", path: "/auth/forgot-password" }),
  reset: Object.freeze({ method: "POST", path: "/auth/reset-password" }),
});

// Limites espelham o backend (app/schemas/auth.py): EMAIL_MAX=254, senha 8..128 (não só espaços),
// token opaco 16..256.
const EMAIL_MAX = 254;
const PASSWORD_MIN = 8;
const PASSWORD_MAX = 128;
const TOKEN_MIN = 16;
const TOKEN_MAX = 256;
const CONTROL = /[\u0000-\u001f\u007f]/;

// Códigos de erro do backend que estas rotas repassam (com a mensagem pública do próprio backend).
const KNOWN_ERRORS = Object.freeze({
  status: new Set(["rate_limited"]),
  forgot: new Set(["validation_error", "rate_limited", "password_recovery_unavailable"]),
  reset: new Set(["validation_error", "rate_limited", "invalid_reset_token", "concurrent_update"]),
});

// Comprimento em pontos de código, como `len()` no Python (o `.length` do JS conta unidades UTF-16).
const cpLength = (value) => [...value].length;

const exactKeys = (value, keys) => {
  const got = Object.keys(value);
  return got.length === keys.length && keys.every((k) => Object.hasOwn(value, k));
};

/** @returns {string | null} motivo genérico (sem o valor) ou null se válido */
export function validateForgotBody(value) {
  if (!value || !exactKeys(value, ["email"])) return "Envie somente o e-mail.";
  const { email } = value;
  if (typeof email !== "string") return "E-mail inválido.";
  const trimmed = email.trim();
  if (!trimmed || cpLength(trimmed) > EMAIL_MAX || CONTROL.test(trimmed) || !trimmed.includes("@")) return "E-mail inválido.";
  return null;
}

/** @returns {string | null} */
export function validateResetBody(value) {
  if (!value || !exactKeys(value, ["token", "newPassword"])) return "Envie somente o token e a nova senha.";
  const { token, newPassword } = value;
  if (typeof token !== "string" || cpLength(token) < TOKEN_MIN || cpLength(token) > TOKEN_MAX) return "Link de redefinição inválido.";
  if (typeof newPassword !== "string" || cpLength(newPassword) < PASSWORD_MIN || cpLength(newPassword) > PASSWORD_MAX
      || !newPassword.trim()) {
    return `A senha deve ter entre ${PASSWORD_MIN} e ${PASSWORD_MAX} caracteres.`;
  }
  return null;
}

/**
 * @param {object} deps funções internas do BFF (mesmas proteções das demais rotas)
 */
export function createPublicRecovery({ call, guard, readJson, json, err, clientIp, log }) {
  const unavailable = () => err(503, "backend_unavailable", "Serviço indisponível. Tente novamente.");
  const unknownOutcome = () => json(504, {
    error: { code: "upstream_timeout", message: "Sem confirmação do servidor; verifique antes de repetir." },
    outcome: "unknown",
  });

  /** Pré-condições comuns: método, query, CSRF/Origin. Nada vai ao backend se falhar. */
  function precheck(request, route) {
    if (request.method !== route.method) return err(405, "method_not_allowed", "Método não permitido.");
    if (new URL(request.url).search) return err(422, "validation_error", "Parâmetros não são aceitos.");
    const denied = guard(request);
    if (denied) return err(denied.status, denied.code, denied.message);
    return null;
  }

  /** Erro do backend reduzido a { error: { code, message } } com código conhecido; demais → genérico. */
  function sanitizedError(name, r) {
    const extra = {};
    const retry = r.headers.get("retry-after");
    if (r.status === 429 && retry && /^\d{1,6}$/.test(retry)) extra["retry-after"] = retry;
    const code = r.json?.error?.code;
    const message = r.json?.error?.message;
    if (r.status >= 500 && !(r.status === 503 && code === "password_recovery_unavailable")) return unavailable();
    if (typeof code === "string" && KNOWN_ERRORS[name].has(code) && typeof message === "string") {
      return err(r.status, code, message.slice(0, 200), extra);
    }
    return err(r.status >= 400 && r.status < 500 ? r.status : 502, "upstream_error", "Não foi possível concluir.", extra);
  }

  async function forward(request, name, body) {
    const route = ROUTES[name];
    const r = await call({ method: route.method, path: route.path, body, clientIp: clientIp(request) });
    if (r.kind === "unreachable") return { response: unavailable() };
    if (r.kind === "uncertain") {
      log("public_password_uncertain", { route: name, reason: r.reason });
      // Leitura: indisponível. Mutação: pode ter sido processada → desconhecido, sem nova tentativa.
      return { response: route.method === "GET" ? unavailable() : unknownOutcome() };
    }
    return { result: r };
  }

  async function passwordStatus(request) {
    const pre = precheck(request, ROUTES.status);
    if (pre) return pre;
    const { response, result } = await forward(request, "status");
    if (response) return response;
    if (result.status === 200 && typeof result.json?.available === "boolean") {
      return json(200, { available: result.json.available });             // somente o booleano
    }
    if (result.status === 200) return unavailable();                      // forma inesperada
    return sanitizedError("status", result);
  }

  async function passwordForgot(request) {
    const pre = precheck(request, ROUTES.forgot);
    if (pre) return pre;
    const body = await readJson(request);
    if (body.error) return body.error;
    const invalid = validateForgotBody(body.value);
    if (invalid) return err(422, "validation_error", invalid);
    const { response, result } = await forward(request, "forgot", { email: body.value.email });
    if (response) return response;
    if (result.status === 202 && typeof result.json?.message === "string") {
      return json(202, { message: result.json.message.slice(0, 300) });  // a mesma mensagem neutra do backend
    }
    if (result.status === 202) return unknownOutcome();                    // aceito, mas forma inesperada
    return sanitizedError("forgot", result);
  }

  async function passwordReset(request) {
    const pre = precheck(request, ROUTES.reset);
    if (pre) return pre;
    const body = await readJson(request);
    if (body.error) return body.error;
    const invalid = validateResetBody(body.value);
    if (invalid) return err(422, "validation_error", invalid);
    const { token, newPassword } = body.value;
    const { response, result } = await forward(request, "reset", { token, newPassword });
    if (response) return response;
    if (result.status === 204) return json(204, null);                     // sem corpo, sem login automático
    if (result.status >= 200 && result.status < 300) return unknownOutcome();
    return sanitizedError("reset", result);
  }

  return { passwordStatus, passwordForgot, passwordReset };
}

export const PUBLIC_RECOVERY_ROUTES = ROUTES;
