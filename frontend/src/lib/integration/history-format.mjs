// Descrição legível do histórico de prazos. Referências protegidas (`*Hidden`) nunca são
// "reveladas": aparecem como vínculo existente sem identificador. Pessoas viram nomes da projeção
// autorizada (ou rótulo genérico) — nunca ids.

const FIELD = {
  title: "título", caseNumber: "processo", court: "tribunal", practiceArea: "área", priority: "prioridade",
  startDate: "início", dueDate: "vencimento", countingMode: "contagem", duration: "duração", agendaTime: "horário", reviewed: "revisado",
};
const STATUS = { open: "em aberto", completed: "concluído", cancelled: "cancelado" };
const REASON = { edit: "edição", reopen: "reabertura", member_removed: "remoção de membro", member_left: "saída de membro" };

export function describeEvent(event, nameOf) {
  const d = event.details ?? {};
  const hidden = Object.keys(d).some((k) => k.endsWith("Hidden") && d[k] === true);
  switch (event.action) {
    case "created": {
      const src = d.source && typeof d.source === "object" ? d.source : null;
      const fromIntimation = src && ("intimationId" in src || src.intimationIdHidden);
      return `Prazo criado${d.responsibleId ? ` (responsável: ${nameOf(d.responsibleId)})` : ""}${fromIntimation ? " a partir de uma intimação" : ""}.`;
    }
    case "updated": {
      const names = Object.keys(d.changes ?? {}).map((k) => FIELD[k] ?? "campo");
      return `Alterado: ${names.join(", ") || "dados"}.`;
    }
    case "reassigned":
      return `Responsável alterado de ${nameOf(d.fromResponsibleId)} para ${nameOf(d.toResponsibleId)}${d.reason ? ` (${REASON[d.reason] ?? "outro motivo"})` : ""}.`;
    case "status_changed":
      return `Status: ${STATUS[d.from] ?? "—"} → ${STATUS[d.to] ?? "—"}.`;
    case "transferred":
      return `Transferido do ambiente pessoal para o escritório${d.linkedIntimationId || d.linkedIntimationIdHidden ? " (com a intimação vinculada)" : ""}.`;
    default:
      return hidden ? "Evento com vínculo a recurso protegido." : "Evento registrado.";
  }
}
