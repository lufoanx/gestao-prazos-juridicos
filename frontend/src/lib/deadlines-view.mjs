// Consultas e organização DEMONSTRATIVAS sobre prazos.
// Nada aqui é cálculo processual oficial — apenas busca, filtro, paginação e
// montagem do calendário para apresentação.
import { urgencyOf } from "./urgency.mjs";
import { civilToDays, addDays, weekdayIndex } from "./dates.mjs";

/** O prazo pertence ao ambiente (escopo) atual? Garante isolamento pessoal/escritório. */
export function matchesScope(d, scope) {
  if (!d || !d.scope || d.scope.kind !== scope.kind) return false;
  if (scope.kind === "personal") return d.scope.ownerId === scope.ownerId;
  return d.scope.officeId === scope.officeId;
}

export function filterDeadlines(list, opts = {}) {
  const { query = "", status = "all", urgency = "all", area = "all", today } = opts;
  const q = String(query).trim().toLowerCase();
  return list.filter((d) => {
    if (status !== "all" && d.status !== status) return false;
    if (area !== "all" && d.practiceArea !== area) return false;
    if (urgency !== "all") {
      if (d.status !== "open") return false;
      if (urgencyOf(d.dueDate, today).level !== urgency) return false;
    }
    if (q) {
      const hay = `${d.title} ${d.caseNumber} ${d.court} ${d.practiceArea}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

const STATUS_ORDER = { open: 0, completed: 1, cancelled: 2 };
const PRIORITY_ORDER = { high: 0, normal: 1 };

export function sortDeadlines(list, key = "dueDate", dir = "asc") {
  const f = dir === "asc" ? 1 : -1;
  const val = (d) => {
    switch (key) {
      case "title": return d.title.toLowerCase();
      case "status": return STATUS_ORDER[d.status] ?? 9;
      case "priority": return PRIORITY_ORDER[d.priority] ?? 9;
      case "caseNumber": return d.caseNumber;
      default: return civilToDays(d.dueDate);
    }
  };
  return [...list].sort((a, b) => {
    const va = val(a), vb = val(b);
    if (va < vb) return -1 * f;
    if (va > vb) return 1 * f;
    return 0;
  });
}

export function paginate(list, page = 1, perPage = 8) {
  const total = list.length;
  const pageCount = Math.max(1, Math.ceil(total / perPage));
  const p = Math.min(Math.max(1, page), pageCount);
  const start = (p - 1) * perPage;
  return { items: list.slice(start, start + perPage), page: p, pageCount, total };
}

export function distinctAreas(list) {
  return [...new Set(list.map((d) => d.practiceArea).filter(Boolean))].sort();
}

/** Matriz do mês (6 semanas × 7 dias, domingo→sábado) de datas civis. */
export function monthMatrix(year, month1) {
  const first = `${year}-${String(month1).padStart(2, "0")}-01`;
  const startPad = weekdayIndex(first); // 0=domingo
  const gridStart = addDays(first, -startPad);
  const weeks = [];
  for (let w = 0; w < 6; w++) {
    const row = [];
    for (let d = 0; d < 7; d++) row.push(addDays(gridStart, w * 7 + d));
    weeks.push(row);
  }
  return weeks;
}

/** Agrupa prazos por data de vencimento (YYYY-MM-DD → lista). */
export function groupByDueDate(list) {
  const map = {};
  for (const d of list) { (map[d.dueDate] ||= []).push(d); }
  return map;
}
