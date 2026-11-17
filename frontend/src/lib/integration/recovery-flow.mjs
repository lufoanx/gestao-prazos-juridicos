// Estado das telas de recuperação de senha (E5), sem React: transições puras + classificação dos
// erros do BFF. A apresentação (src/integrated/Recovery*.tsx) só desenha a fase atual.
//
// Princípios:
// - nenhuma repetição automática: toda nova tentativa nasce de uma ação explícita da pessoa;
// - um envio por vez: `submit` só é aceito na fase "form" (e a tela usa um guarda síncrono);
// - "resultado desconhecido" (504 outcome=unknown ou falha de rede DEPOIS do clique) nunca é
//   apresentado como falha: a operação pode ter ocorrido;
// - nenhuma mensagem contém token, senha ou e-mail.
import { ApiError } from "./api-client.mjs";
import { PASSWORD_MAX, PASSWORD_MIN, emailProblem, passwordProblem } from "./recovery-rules.mjs";

export const RECOVERY_TEXT = Object.freeze({
  accepted: "Se houver uma conta com esse e-mail, enviaremos um link. Verifique a caixa de entrada e o spam.",
  acceptedNote: "Só o link mais recente funciona: um novo pedido invalida o anterior.",
  disabled: "A recuperação de senha por e-mail não está disponível neste ambiente no momento. Nenhum e-mail será enviado.",
  statusError: "Não foi possível verificar se a recuperação de senha está disponível.",
  forgotUnknown: "O servidor não confirmou o pedido: ele pode ter sido registrado. Verifique sua caixa de entrada (e o spam) antes de pedir de novo — um novo pedido invalida o link anterior.",
  unavailable: "Serviço indisponível no momento. Tente novamente em instantes.",
  generic: "Não foi possível concluir. Tente novamente.",
  missingLink: "Este link está incompleto ou foi alterado. Abra o link completo recebido por e-mail ou peça um novo.",
  invalidLink: "Este link de redefinição não é mais válido: ele pode ter expirado, já ter sido usado ou ter sido substituído por um pedido mais recente.",
  passwordRejected: `A nova senha não foi aceita. Use entre ${PASSWORD_MIN} e ${PASSWORD_MAX} caracteres, sem ser só espaços.`,
  mismatch: "As senhas não coincidem.",
  concurrent: "A redefinição não foi aplicada porque a conta mudou ao mesmo tempo. Tente novamente.",
  resetUnknown: "O servidor não confirmou a redefinição: ela pode ter sido concluída. Antes de tentar de novo, confira entrando com a NOVA senha. Se não funcionar, entre com a senha antiga ou peça um novo link.",
  success: "Senha redefinida. Entre com a nova senha. Por segurança, as sessões abertas com a senha anterior foram encerradas.",
  memoryOnly: "Este link fica guardado só nesta aba. Se recarregar ou fechar a página antes de concluir, abra o link do e-mail novamente.",
});

/** Retry-After em segundos (somente inteiro positivo razoável); null se ausente ou inválido. */
export function parseRetryAfter(value) {
  if (typeof value !== "string" || !/^\d{1,6}$/.test(value)) return null;
  const n = Number(value);
  return n >= 1 && n <= 86400 ? n : null;
}

export function rateLimitText(retryAfter) {
  return retryAfter
    ? `Muitas solicitações. Aguarde ${retryAfter} segundo${retryAfter === 1 ? "" : "s"} antes de tentar novamente.`
    : "Muitas solicitações. Aguarde alguns minutos antes de tentar novamente.";
}

const isUnknown = (e) => e instanceof ApiError && (e.category === "unknown_outcome" || e.category === "network");

/** Erro de /forgot → próxima fase. */
export function classifyForgotError(e) {
  if (!(e instanceof ApiError)) return { phase: "form", error: RECOVERY_TEXT.generic };
  if (e.category === "rate_limited") return { phase: "rate_limited", retryAfter: parseRetryAfter(e.retryAfter) };
  if (e.code === "password_recovery_unavailable") return { phase: "disabled" };
  if (isUnknown(e)) return { phase: "unknown" };
  if (e.category === "validation") return { phase: "form", error: "Informe um e-mail válido.", field: "email" };
  if (e.category === "unavailable") return { phase: "form", error: RECOVERY_TEXT.unavailable };
  return { phase: "form", error: RECOVERY_TEXT.generic };
}

/** Erro de /reset → próxima fase. `dropToken` indica que o token não serve mais. */
export function classifyResetError(e) {
  if (!(e instanceof ApiError)) return { phase: "form", error: RECOVERY_TEXT.generic };
  if (e.code === "invalid_reset_token") return { phase: "invalid_link", dropToken: true };
  if (e.category === "rate_limited") return { phase: "rate_limited", retryAfter: parseRetryAfter(e.retryAfter) };
  if (isUnknown(e)) return { phase: "unknown" };
  if (e.category === "validation") return { phase: "form", error: RECOVERY_TEXT.passwordRejected, field: "password" };
  if (e.code === "concurrent_update") return { phase: "form", error: RECOVERY_TEXT.concurrent };
  if (e.category === "unavailable") return { phase: "form", error: RECOVERY_TEXT.unavailable };
  return { phase: "form", error: RECOVERY_TEXT.generic };
}

/** Validação local do pedido (subconjunto das regras do BFF/backend). */
export function checkForgotForm(email) {
  return emailProblem(email) ? { email: "Informe um e-mail válido." } : {};
}

/** Validação local da nova senha e da confirmação. */
export function checkResetForm({ password, confirm }) {
  const errors = {};
  const p = passwordProblem(password);
  if (p) errors.password = p;
  if (confirm !== password) errors.confirm = RECOVERY_TEXT.mismatch;
  return errors;
}

// Com Retry-After, a nova tentativa só é liberada quando o prazo informado passa (a tela agenda o
// fim da espera e despacha `cooldown`); sem Retry-After, a pessoa decide quando tentar.
const withCooldown = (next) => (next.phase === "rate_limited" ? { ...next, waiting: Boolean(next.retryAfter) } : next);

// ------------------------------------------------------------------------------------ /esqueci-senha
// Fases: checking · disabled · status_error · form · sending · accepted · rate_limited · unknown
export const FORGOT_INITIAL = Object.freeze({ phase: "checking" });

export function forgotReducer(state, action) {
  switch (action.type) {
    case "check":                                     // consulta (inicial ou nova consulta EXPLÍCITA)
      return state.phase === "sending" ? state : { phase: "checking" };
    case "status":
      if (state.phase !== "checking") return state;
      return action.available ? { phase: "form" } : { phase: "disabled" };
    case "status_failed":
      return state.phase === "checking" ? { phase: "status_error" } : state;
    case "submit":
      return state.phase === "form" ? { phase: "sending" } : state;   // um envio por vez
    case "invalid":
      return state.phase === "form" ? { phase: "form", error: action.error, field: action.field } : state;
    case "accepted":
      return state.phase === "sending" ? { phase: "accepted" } : state;
    case "failed":
      if (state.phase !== "sending") return state;
      return withCooldown({ ...action.outcome });
    case "edit":                                      // voltar ao formulário por ação explícita
      if (state.phase === "rate_limited" && state.waiting) return state;
      return ["accepted", "unknown", "rate_limited", "form"].includes(state.phase) ? { phase: "form" } : state;
    case "cooldown":
      return state.phase === "rate_limited" ? { ...state, waiting: Boolean(action.waiting) } : state;
    default:
      return state;
  }
}

// ---------------------------------------------------------------------------------- /redefinir-senha
// Fases: reading · missing · form · sending · success · invalid_link · rate_limited · unknown
export const RESET_INITIAL = Object.freeze({ phase: "reading" });

export function resetReducer(state, action) {
  switch (action.type) {
    case "captured":                                  // leitura do fragmento (ou novo link na aba)
      if (state.phase === "sending") return state;
      return action.hasToken ? { phase: "form" } : { phase: "missing" };
    case "submit":
      return state.phase === "form" ? { phase: "sending" } : state;
    case "invalid":
      return state.phase === "form" ? { phase: "form", error: action.error, field: action.field } : state;
    case "success":
      return state.phase === "sending" ? { phase: "success" } : state;
    case "failed":
      if (state.phase !== "sending") return state;
      return withCooldown({ phase: action.outcome.phase, error: action.outcome.error, field: action.outcome.field, retryAfter: action.outcome.retryAfter });
    case "edit":
      if (state.phase === "rate_limited" && state.waiting) return state;
      return ["unknown", "rate_limited", "form"].includes(state.phase) ? { phase: "form" } : state;
    case "cooldown":
      return state.phase === "rate_limited" ? { ...state, waiting: Boolean(action.waiting) } : state;
    default:
      return state;
  }
}

/** Guarda síncrono de envio único: impede o segundo clique antes de o React re-renderizar. */
export function createSingleFlight() {
  let busy = false;
  return {
    get busy() { return busy; },
    async run(fn) {
      if (busy) return { started: false };
      busy = true;
      try {
        return { started: true, value: await fn() };
      } catch (error) {
        return { started: true, error };
      } finally {
        busy = false;
      }
    },
  };
}
