// Dashboard integrado: TODOS os números vêm de totais do SERVIDOR (consultas filtradas por status e
// urgência, já autorizadas e recortadas pelo ambiente). Nada é contado a partir de página parcial nem
// calculado com o relógio do navegador: a urgência e a data de referência são as do servidor.
import { canonicalQuery, LIST_PARAMS } from "./deadlines-client.mjs";

/** Quantos itens de cada grupo urgente entram na lista do painel (o total vem do servidor). */
export const URGENT_PER_GROUP = 10;
/** Itens da agenda do dia (prazos que vencem hoje). */
export const AGENDA_LIMIT = 50;
/** Intimações aguardando revisão exibidas no painel. */
export const REVIEW_LIMIT = 5;

/** As consultas do painel, na ordem em que são feitas (a mesma string serve de chave de cache). */
export function dashboardQueries(scope) {
  const base = { scope, sort: "dueDate", dir: "asc" };
  return {
    overdue: { ...base, status: "open", urgency: "overdue", perPage: URGENT_PER_GROUP },
    today: { ...base, status: "open", urgency: "today", perPage: AGENDA_LIMIT },
    soon: { ...base, status: "open", urgency: "soon", perPage: URGENT_PER_GROUP },
    open: { ...base, status: "open", perPage: 1 },
    completed: { ...base, status: "completed", perPage: 1 },
    all: { ...base, perPage: 1 },
  };
}

/** Chave estável do recurso (prefixo "deadlines" → invalidada junto com as listas após mutações). */
export function dashboardResourceKey(scope) {
  return `deadlines?dashboard&${canonicalQuery({ scope }, LIST_PARAMS)}`;
}

/** Busca as seis páginas em paralelo e devolve o resumo. */
export async function fetchDashboard(client, scope) {
  const q = dashboardQueries(scope);
  const [overdue, today, soon, open, completed, all] = await Promise.all([
    client.list(q.overdue), client.list(q.today), client.list(q.soon),
    client.list(q.open), client.list(q.completed), client.list(q.all),
  ]);
  return summarizeDashboard({ overdue, today, soon, open, completed, all });
}

const byAgendaTime = (a, b) => {
  const ta = a.agendaTime || "99:99";
  const tb = b.agendaTime || "99:99";
  return ta !== tb ? ta.localeCompare(tb) : a.title.localeCompare(b.title, "pt-BR");
};

/**
 * Monta o painel a partir das páginas do servidor.
 * - urgentes: vencidos primeiro (mais antigos antes), depois os de hoje, depois os próximos;
 * - agenda: os que vencem hoje, por horário (sem horário no fim);
 * - contadores: sempre o `total` informado pelo servidor.
 * `consistent` = todas as respostas usaram a MESMA data de referência (falso se a virada do dia
 * aconteceu entre as consultas; a tela então pede para atualizar em vez de misturar dias).
 */
export function summarizeDashboard({ overdue, today, soon, open, completed, all }) {
  const pages = [overdue, today, soon, open, completed, all];
  const referenceDate = overdue.referenceDate;
  const consistent = pages.every((p) => p.referenceDate === referenceDate);
  const urgent = [...overdue.items, ...today.items, ...soon.items];
  const urgentTotal = overdue.total + today.total + soon.total;
  return {
    referenceDate,
    consistent,
    urgent,
    urgentTotal,
    urgentHidden: urgentTotal - urgent.length,
    agenda: [...today.items].sort(byAgendaTime),
    agendaHidden: today.total - today.items.length,
    overview: {
      overdue: overdue.total,
      dueToday: today.total,
      soon: soon.total,
      open: open.total,
      completed: completed.total,
      total: all.total,
    },
  };
}
