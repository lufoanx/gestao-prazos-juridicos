// Datas civis (YYYY-MM-DD) tratadas como dias-calendário puros.
// Toda aritmética usa UTC apenas internamente para evitar deslocamento de fuso
// (as datas NÃO representam instantes, e sim dias civis). Nada aqui é cálculo
// processual oficial — é apenas apresentação/organização demonstrativa.

const WEEKDAYS = ["domingo","segunda-feira","terça-feira","quarta-feira","quinta-feira","sexta-feira","sábado"];
const WEEKDAYS_SHORT = ["Dom","Seg","Ter","Qua","Qui","Sex","Sáb"];
const MONTHS_SHORT = ["jan","fev","mar","abr","mai","jun","jul","ago","set","out","nov","dez"];

/** @param {string} iso @returns {[number,number,number]} */
function parts(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return [y, m, d];
}

/** Dias inteiros desde a época, a partir de uma data civil. */
export function civilToDays(iso) {
  const [y, m, d] = parts(iso);
  return Math.floor(Date.UTC(y, m - 1, d) / 86400000);
}

/** Diferença em dias civis entre `a` e `b` (a - b). */
export function diffDays(a, b) {
  return civilToDays(a) - civilToDays(b);
}

/** Soma `n` dias a uma data civil, devolvendo YYYY-MM-DD. */
export function addDays(iso, n) {
  const [y, m, d] = parts(iso);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

/** Índice do dia da semana (0=domingo). */
export function weekdayIndex(iso) {
  const [y, m, d] = parts(iso);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** "18/09/2026" */
export function formatCivil(iso) {
  const [y, m, d] = parts(iso);
  return `${String(d).padStart(2, "0")}/${String(m).padStart(2, "0")}/${y}`;
}

/** "18 set" */
export function formatShort(iso) {
  const [, m, d] = parts(iso);
  return `${String(d).padStart(2, "0")} ${MONTHS_SHORT[m - 1]}`;
}

/** "quinta-feira" */
export function weekdayName(iso) {
  return WEEKDAYS[weekdayIndex(iso)];
}

/** "Qui" */
export function weekdayShort(iso) {
  return WEEKDAYS_SHORT[weekdayIndex(iso)];
}

/**
 * Texto relativo demonstrativo entre `iso` e `today`.
 * Ex.: "vencido há 1 dia", "vence hoje", "em 3 dias".
 */
export function relativeToToday(iso, today) {
  const d = diffDays(iso, today);
  if (d < 0) return d === -1 ? "vencido há 1 dia" : `vencido há ${-d} dias`;
  if (d === 0) return "vence hoje";
  if (d === 1) return "vence amanhã";
  return `em ${d} dias`;
}
