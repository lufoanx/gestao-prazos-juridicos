// Mensagens para a interface a partir das categorias de erro (estados distintos).
import { ApiError } from "@/lib/integration/api-client.mjs";

export function errorMessage(e: unknown, fallback = "Não foi possível concluir a operação."): string {
  if (!(e instanceof ApiError)) return fallback;
  switch (e.category) {
    case "network": return "Sem conexão com o servidor. Verifique sua rede e tente novamente.";
    case "unavailable": return "Serviço indisponível no momento. Tente novamente em instantes.";
    case "unknown_outcome": return "O servidor não confirmou a operação. Verifique antes de repetir.";
    case "rate_limited":
      return `Muitas tentativas. Tente novamente${e.retryAfter ? ` em ${e.retryAfter} segundos` : " mais tarde"}.`;
    case "session": return "Sua sessão terminou. Entre novamente.";
    default: return e.message || fallback;
  }
}

/** Mensagens dos códigos de domínio da 6.2 (o texto do servidor é o padrão). */
const ORG_MESSAGES: Record<string, string> = {
  already_in_office: "Você já pertence a um escritório. Saia dele antes de entrar em outro.",
  reassign_required: "Há responsabilidades em aberto (prazos ou intimações) que precisam ser reatribuídas. Escolha quem as receberá.",
  successor_required: "Você é o último administrador. Indique um membro para assumir a administração.",
  last_admin: "O escritório precisa manter ao menos um administrador.",
  invalid_successor: "Escolha outro membro como sucessor.",
  cannot_remove_self: "Para deixar o escritório, use a opção de saída.",
  delegation_not_allowed: "Você só pode atribuir, conceder ou delegar o que a sua própria autorização permite (com visibilidade restrita, só a si mesmo; privilégios administrativos exigem administrador).",
  self_escalation_forbidden: "Não é possível ampliar as próprias permissões.",
  invalid_permission_set: "Conjunto de permissões inválido.",
  join_code_invalid: "Código de ingresso inválido.",
  request_already_pending: "Você já tem uma solicitação pendente para este escritório.",
  pending_limit_reached: "Limite de solicitações pendentes atingido.",
  request_not_pending: "Esta solicitação não está mais pendente.",
  invitation_not_pending: "Este convite não está mais pendente.",
  invitation_invalid: "Convite inválido.",
  invitation_expired: "Este convite expirou.",
  invitation_revoked: "Este convite foi revogado.",
  invitation_used: "Este convite já foi utilizado.",
  forbidden: "Você não tem permissão para esta operação.",
  // 6.3 — prazos
  version_conflict: "Este prazo foi alterado por outra pessoa ou aba depois que você o abriu. Nada foi salvo.",
  status_unchanged: "O prazo já está neste status.",
  invalid_transition: "Transição de status não permitida. Reabra o prazo antes.",
  responsible_inactive: "O responsável não pertence mais ao escritório. Escolha um novo responsável para reabrir.",
  responsible_invalid: "Responsável inválido para este ambiente.",
  invalid_dates: "O vencimento não pode ser anterior ao início.",
  not_transferable: "Somente prazos pessoais podem ser transferidos ao escritório.",
  linked_intimation_requires_consent: "Este prazo tem uma intimação vinculada. É preciso confirmar também o compartilhamento dela.",
  comment_limit_reached: "Limite de comentários deste prazo atingido.",
  deadline_limit_reached: "Limite de prazos do ambiente atingido.",
  history_limit_reached: "Limite de histórico deste prazo atingido.",
  validation_error: "Dados inválidos. Revise os campos.",
};

export function orgErrorMessage(e: unknown, fallback?: string): string {
  if (e instanceof ApiError && ORG_MESSAGES[e.code]) return ORG_MESSAGES[e.code];
  return errorMessage(e, fallback);
}
