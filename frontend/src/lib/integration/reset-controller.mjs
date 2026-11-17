// Coordenação COMPLETA da tela /redefinir-senha (E5, corrigida na auditoria — doc 21, §23):
// captura do fragmento + estado da tela + envio único + resposta do servidor, num só lugar e sem
// React (o hook só assina as mudanças). Assim a composição inteira é testável com gates.
//
// Protocolo de revisões:
// - cada leitura nova da barra (link aberto ou outro link na mesma aba) recebe uma revisão do holder;
// - cada tentativa guarda a revisão da captura que a originou;
// - ao chegar a resposta, se a revisão atual for outra, a resposta é de um link SUBSTITUÍDO: não
//   apaga o token novo, não muda a tela para sucesso/erro/limite/desconhecido e só libera o
//   formulário do novo link (`settled_stale`). A operação de A pode ter sido concluída no servidor:
//   nada aqui a desfaz nem a repete;
// - um link novo descarta senha e confirmação digitadas para o link anterior;
// - nada é enviado sem `submit()` explícito; um envio por vez (guarda síncrono).
import { createFragmentTokenHolder } from "./fragment-token.mjs";
import { RESET_INITIAL, checkResetForm, classifyResetError, createSingleFlight, resetReducer } from "./recovery-flow.mjs";

const EMPTY = Object.freeze({ password: "", confirm: "" });

export function createResetController({ client, getWindow }) {
  const holder = createFragmentTokenHolder();
  const flight = createSingleFlight();
  const listeners = new Set();
  let snapshot = Object.freeze({ state: RESET_INITIAL, ...EMPTY });

  const publish = (next) => {
    snapshot = Object.freeze({ ...snapshot, ...next });
    for (const fn of listeners) fn();
  };
  const dispatch = (action) => publish({ state: resetReducer(snapshot.state, action) });

  return {
    get snapshot() { return snapshot; },
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },

    /** Lê a barra (montagem e `hashchange`). Idempotente sob efeitos repetidos. */
    read() {
      const { token, fresh } = holder.capture(getWindow());
      if (!fresh && snapshot.state.phase !== "reading") return;
      if (fresh) publish(EMPTY);                                  // senhas do link anterior descartadas
      dispatch({ type: "captured", hasToken: token !== null });
    },

    setPassword(password) { publish({ password }); },
    setConfirm(confirm) { publish({ confirm }); },
    edit() { dispatch({ type: "edit" }); },
    endCooldown() { dispatch({ type: "cooldown", waiting: false }); },

    /** Envio EXPLÍCITO. Fora da fase "form" não faz nada (a tela nem oferece o botão). */
    async submit() {
      if (snapshot.state.phase !== "form" || flight.busy) return;
      const { password, confirm } = snapshot;
      const errors = checkResetForm({ password, confirm });
      if (errors.password) { dispatch({ type: "invalid", error: errors.password, field: "password" }); return; }
      if (errors.confirm) { dispatch({ type: "invalid", error: errors.confirm, field: "confirm" }); return; }
      const token = holder.token;
      const revision = holder.revision;                          // a tentativa pertence a ESTA captura
      if (!token) { dispatch({ type: "captured", hasToken: false }); return; }
      await flight.run(async () => {
        dispatch({ type: "submit" });
        let outcome = null;
        try {
          await client.reset(token, password);
        } catch (e) {
          outcome = classifyResetError(e);
        }
        if (holder.revision !== revision) {                      // link substituído durante o envio
          dispatch({ type: "settled_stale" });
          return;
        }
        if (outcome === null) {
          holder.clear(revision);                                // token e senhas saem da memória
          publish(EMPTY);
          dispatch({ type: "success" });
          return;
        }
        if (outcome.dropToken) holder.clear(revision);
        dispatch({ type: "failed", outcome });                   // nunca repete sozinho
      });
    },
  };
}
