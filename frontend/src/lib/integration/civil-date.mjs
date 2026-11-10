// Datas CIVIS de prazo ("YYYY-MM-DD"): manipuladas como texto/aritmética UTC pura.
// Nunca `new Date("2026-11-20")` em fuso local (que pode mudar o dia).

const RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isCivilDate(v) {
  const m = typeof v === "string" && RE.exec(v);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}

/** "2026-11-20" → "20/11/2026" (sem fuso). */
export function formatCivilDate(v) {
  const m = typeof v === "string" && RE.exec(v);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : "—";
}

export function parts(v) {
  const m = RE.exec(v);
  return m ? { year: +m[1], month: +m[2], day: +m[3] } : null;
}

const pad = (n) => String(n).padStart(2, "0");
export const civil = (year, month, day) => `${year}-${pad(month)}-${pad(day)}`;

/** Mês anterior/seguinte. */
export function addMonths(year, month, delta) {
  const idx = year * 12 + (month - 1) + delta;
  return { year: Math.floor(idx / 12), month: (idx % 12) + 1 };
}

/** Semanas do mês (domingo a sábado), com datas civis; células fora do mês = null. */
export function monthGrid(year, month) {
  const first = new Date(Date.UTC(year, month - 1, 1));
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const offset = first.getUTCDay();
  const cells = [];
  for (let i = 0; i < offset; i++) cells.push(null);
  for (let d = 1; d <= days; d++) cells.push(civil(year, month, d));
  while (cells.length % 7 !== 0) cells.push(null);
  const weeks = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
}

export const MONTH_NAMES = Object.freeze(["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"]);
