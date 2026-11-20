// Entrada no ambiente do escritório — decisão de INTERFACE compartilhada pelos modos demo e integrado
// (doc 26). Não é autorização: o servidor (modo integrado) ou as regras locais (demo) decidem de verdade.
//
// Uma conta só: o mesmo login acessa o ambiente pessoal (sempre existe) e, se houver vínculo, o do
// escritório. Trocar de ambiente é só contexto de navegação; nada é transferido.

/**
 * @param {{ status?: string, hasOffice: boolean, scope: string }} s
 * @returns {"loading" | "error" | "no-office" | "personal" | "office"}
 */
export function officeEntryState({ status = "ready", hasOffice, scope }) {
  if (status === "loading" || status === "idle") return "loading";
  if (status !== "ready") return "error";                 // nunca "sem escritório" enquanto não se sabe
  if (!hasOffice) return "no-office";
  return scope === "office" ? "office" : "personal";
}

export const OFFICE_ENTRY_TEXT = Object.freeze({
  noOffice: "Você não pertence a um escritório no momento.",
  noOfficeHow: "Use a mesma conta: crie um escritório ou peça para entrar em um existente. Seu ambiente pessoal continua só seu.",
  createAction: "Criar escritório",
  joinAction: "Solicitar ingresso com código",
  inviteHint: "Recebeu um convite? Abra o link enviado por quem administra o escritório.",
  personal: "Você está no ambiente pessoal.",
  personalHow: "Esta área é do escritório. Abra o ambiente do escritório para continuar; nenhum dado é transferido entre os ambientes.",
  openOfficeAction: "Abrir ambiente do escritório",
  switchNoOffice: "Sem escritório:",
  switchNoOfficeAction: "criar ou ingressar",
  loadError: "Não foi possível carregar o vínculo com escritório.",
  waiting: "Esta área depende do vínculo com escritório, que ainda não foi carregado.",
});
