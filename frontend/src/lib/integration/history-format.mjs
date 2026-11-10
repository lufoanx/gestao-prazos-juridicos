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

/** Histórico de INTIMAÇÃO (legível, sem JSON bruto nem identificadores protegidos). */
const INTIMATION_STATUS = { processing: "em processamento", awaiting_review: "aguardando revisão", failed: "falha", reviewed: "revisada", discarded: "descartada" };
const DRAFT_FIELD = { ...FIELD };

export function describeIntimationEvent(event, nameOf) {
  const d = event.details ?? {};
  switch (event.action) {
    case "registered":
      return `Intimação registrada (somente metadados; arquivo não armazenado)${d.suggestedResponsibleId ? ` · responsável sugerido: ${nameOf(d.suggestedResponsibleId)}` : ""}.`;
    case "draft_updated": {
      const names = Object.keys(d.changes ?? {}).map((k) => DRAFT_FIELD[k] ?? "campo");
      return `Rascunho alterado: ${names.join(", ") || "dados"}.`;
    }
    case "responsible_suggested":
      return d.toResponsibleId ? `Responsável sugerido: ${nameOf(d.toResponsibleId)}.` : "Sugestão de responsável removida.";
    case "responsible_reassigned":
      return `Responsável sugerido alterado para ${nameOf(d.toResponsibleId)}${d.reason ? ` (${REASON[d.reason] ?? "outro motivo"})` : ""}.`;
    case "confirmed":
      return d.deadlineIdHidden ? "Revisão confirmada; prazo criado (vínculo sem permissão de leitura para você)." : "Revisão confirmada; prazo criado.";
    case "discarded":
      return `Intimação descartada${d.fromStatus ? ` (estava ${INTIMATION_STATUS[d.fromStatus] ?? "pendente"})` : ""}.`;
    case "transferred":
      return "Transferida do ambiente pessoal para o escritório junto com o prazo vinculado.";
    case "retry_requested":
      return "Nova tentativa de processamento solicitada.";
    case "processing_completed":
      return "Processamento concluído (sugestões exigem revisão humana).";
    case "processing_failed":
      return "Processamento falhou.";
    default:
      return Object.keys(d).some((k) => k.endsWith("Hidden")) ? "Evento com vínculo a recurso protegido." : "Evento registrado.";
  }
}
