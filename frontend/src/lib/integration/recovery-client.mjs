// Cliente HTTP PÚBLICO da recuperação de senha (E5): só as três rotas públicas do BFF (E4).
// Instância própria do cliente do BFF: não participa da "época" da sessão (um login/logout em
// outra aba não aborta nem descarta um pedido de recuperação em curso) e nunca fala com o backend
// diretamente. O token e a senha vão SÓ no corpo do POST; nada vai para a URL.
import { createApiClient } from "./api-client.mjs";

export const RECOVERY_PATHS = Object.freeze({
  status: "/bff/public/password/status",
  forgot: "/bff/public/password/forgot",
  reset: "/bff/public/password/reset",
});

export function createRecoveryClient({ api = createApiClient() } = {}) {
  return {
    /** @returns {Promise<{ available: boolean }>} */
    async status() {
      const data = await api.request("GET", RECOVERY_PATHS.status);
      if (typeof data?.available !== "boolean") throw new Error("resposta de disponibilidade inesperada");
      return { available: data.available };
    },
    /** 202 neutro: nunca diz se a conta existe nem se algum e-mail saiu. */
    forgot: (email) => api.request("POST", RECOVERY_PATHS.forgot, { email }),
    /** 204 sem corpo: senha trocada, sem login automático. */
    reset: (token, newPassword) => api.request("POST", RECOVERY_PATHS.reset, { token, newPassword }),
  };
}
