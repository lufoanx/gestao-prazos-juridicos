// Derivação de URGÊNCIA a partir da data de vencimento e do relógio demonstrativo.
// IMPORTANTE: é um agrupamento VISUAL demonstrativo (vencido/hoje/próximo/futuro),
// NÃO um cálculo de prazo processual oficial. O limiar "próximo" é uma configuração
// de demonstração e não uma regra jurídica aprovada.

import { diffDays } from "./dates.mjs";

/** Dias-limite (calendário) para considerar um prazo "próximo". Config demo. */
export const SOON_THRESHOLD_DAYS = 3;

/**
 * @param {string} dueDate  YYYY-MM-DD
 * @param {string} today    YYYY-MM-DD
 * @returns {{level:"overdue"|"today"|"soon"|"upcoming", days:number}}
 */
export function urgencyOf(dueDate, today) {
  const days = diffDays(dueDate, today);
  let level;
  if (days < 0) level = "overdue";
  else if (days === 0) level = "today";
  else if (days <= SOON_THRESHOLD_DAYS) level = "soon";
  else level = "upcoming";
  return { level, days };
}

/** Um prazo é "urgente" quando está vencido, vence hoje ou está próximo. */
export function isUrgent(level) {
  return level === "overdue" || level === "today" || level === "soon";
}

/** Rótulo e tom de badge por nível (nunca depender só de cor: sempre há texto). */
export const URGENCY_META = {
  overdue:  { label: "Vencido",  tone: "danger"  },
  today:    { label: "Vence hoje", tone: "warning" },
  soon:     { label: "Próximo",  tone: "warning" },
  upcoming: { label: "Futuro",   tone: "neutral"  },
};

/** Ordem de prioridade para listagens (menor = mais urgente). */
export const URGENCY_ORDER = { overdue: 0, today: 1, soon: 2, upcoming: 3 };
