// Montagem do painel a partir de UMA fonte de registros já filtrada por ambiente.
// Regra do escopo: TODOS os números do dashboard derivam dos MESMOS registros das
// listas — nada é inventado. É organização visual demonstrativa, não cálculo oficial.
import { urgencyOf, isUrgent, URGENCY_ORDER } from "./urgency.mjs";
import { diffDays } from "./dates.mjs";

/**
 * @param {import("@/types/domain").Deadline[]} deadlines  já filtrados por ambiente/leitura
 * @param {import("@/types/domain").Intimation[]} intimations  já filtrados por ambiente
 * @param {string} today YYYY-MM-DD
 */
export function buildDashboard(deadlines, intimations, today) {
  const open = deadlines.filter((d) => d.status === "open");
  const completed = deadlines.filter((d) => d.status === "completed");

  // Anota urgência
  const annotated = open.map((d) => ({ ...d, urgency: urgencyOf(d.dueDate, today) }));

  const urgent = annotated
    .filter((d) => isUrgent(d.urgency.level))
    .sort((a, b) => {
      const o = URGENCY_ORDER[a.urgency.level] - URGENCY_ORDER[b.urgency.level];
      return o !== 0 ? o : diffDays(a.dueDate, b.dueDate);
    });

  const agenda = annotated
    .filter((d) => d.dueDate === today)
    .sort((a, b) => (a.agendaTime || "99:99").localeCompare(b.agendaTime || "99:99"));

  const reviews = intimations.filter((i) => i.status === "awaiting_review");

  const overview = {
    total: deadlines.length,
    open: open.length,
    completed: completed.length,
    overdue: annotated.filter((d) => d.urgency.level === "overdue").length,
    dueToday: annotated.filter((d) => d.urgency.level === "today").length,
    soon: annotated.filter((d) => d.urgency.level === "soon").length,
    urgent: urgent.length,
    awaitingReview: reviews.length,
  };

  return { urgent, agenda, reviews, overview };
}
