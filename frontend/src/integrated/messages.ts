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
