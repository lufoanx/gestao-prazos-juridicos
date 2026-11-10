"use client";
// Calendário integrado (6.3). Mês inicial = data de referência DO SERVIDOR. Todas as páginas do mês
// são buscadas (sequencialmente); contagens por dia e total vêm do servidor (mês inteiro autorizado),
// nunca de uma página parcial. Datas civis sem conversão de fuso.
import { useEffect, useState } from "react";
import Link from "next/link";
import { Button, Modal } from "@/components/ui";
import { canonicalQuery, CALENDAR_PARAMS, fetchWholeMonth } from "@/lib/integration/deadlines-client.mjs";
import { MONTH_NAMES, addMonths, formatCivilDate, monthGrid, parts } from "@/lib/integration/civil-date.mjs";
import type { CalendarPage, Deadline, DeadlinePage } from "@/lib/integration/dto.d.mts";
import { useResource } from "./useResource";
import { ScopeGate, useDeadlineContext } from "./deadlineShared";
import { Notice, PageHead, ResourceState } from "./ui";

const WEEK = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];

export function IntegratedCalendar() {
  return <ScopeGate><CalendarStart /></ScopeGate>;
}

function CalendarStart() {
  const { client, scope } = useDeadlineContext();
  // Uma consulta mínima só para obter a data de referência do servidor (fuso do servidor).
  const ref = useResource<DeadlinePage>(`deadlines?scope=${scope}&perPage=1&reference`, () => client.list({ scope, perPage: 1 }));
  return (
    <ResourceState res={ref}>{(data) => {
      const p = parts(data.referenceDate)!;
      return <CalendarView initialYear={p.year} initialMonth={p.month} referenceDate={data.referenceDate} />;
    }}</ResourceState>
  );
}

function CalendarView({ initialYear, initialMonth, referenceDate }: { initialYear: number; initialMonth: number; referenceDate: string }) {
  const { client, scope, nameOf } = useDeadlineContext();
  const [ym, setYm] = useState({ year: initialYear, month: initialMonth });
  const [status, setStatus] = useState<"" | "open" | "completed" | "cancelled">("");
  const [progress, setProgress] = useState<{ page: number; of: number } | null>(null);
  const params = { scope, year: ym.year, month: ym.month, status, perPage: 500 };
  const key = `calendar?${canonicalQuery(params as unknown as Record<string, unknown>, CALENDAR_PARAMS)}&all`;
  const res = useResource<CalendarPage & { complete: boolean }>(key, () =>
    fetchWholeMonth(client, params, { onPage: (page, of) => setProgress({ page, of }) }));
  useEffect(() => { setProgress(null); }, [key]);

  const [openDay, setOpenDay] = useState<string | null>(null);
  const move = (delta: number) => { setOpenDay(null); setYm(addMonths(ym.year, ym.month, delta)); };
  return (
    <div>
      <PageHead title="Calendário">
        <Button variant="secondary" size="sm" onClick={() => move(-1)} aria-label="Mês anterior">‹</Button>
        <strong style={{ minWidth: 160, textAlign: "center" }}>{MONTH_NAMES[ym.month - 1]} de {ym.year}</strong>
        <Button variant="secondary" size="sm" onClick={() => move(1)} aria-label="Próximo mês">›</Button>
      </PageHead>
      <div className="toolbar__field field" style={{ maxWidth: 220 }}>
        <label className="field__label" htmlFor="cal-status">Status</label>
        <select id="cal-status" className="select" value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>
          <option value="">Todos</option><option value="open">Em aberto</option><option value="completed">Concluídos</option><option value="cancelled">Cancelados</option>
        </select>
      </div>
      {res.status === "loading" && progress ? <p aria-busy="true">Carregando página {progress.page} de {progress.of}…</p> : null}
      <ResourceState res={res}>{(data) => {
        const byDay = new Map<string, Deadline[]>();
        for (const d of data.items) byDay.set(d.dueDate, [...(byDay.get(d.dueDate) ?? []), d]);
        return (
          <>
            <p className="result-count" data-testid="calendar-total">
              {data.total} prazo(s) no mês{data.pageCount > 1 ? ` · ${data.pageCount} páginas carregadas` : ""} ·
              referência do servidor: {formatCivilDate(referenceDate)} ({data.timezone})
            </p>
            {!data.complete ? <Notice kind="error">Nem todos os prazos do mês puderam ser carregados. Os números por dia abaixo vêm do servidor e estão completos.</Notice> : null}
            <table className="calendar" aria-label={`Calendário de ${MONTH_NAMES[ym.month - 1]} de ${ym.year}`} style={{ width: "100%", tableLayout: "fixed" }}>
              <thead><tr>{WEEK.map((w) => <th key={w} scope="col">{w}</th>)}</tr></thead>
              <tbody>
                {monthGrid(ym.year, ym.month).map((week, i) => (
                  <tr key={i}>
                    {week.map((day, j) => (
                      <td key={j} style={{ verticalAlign: "top", height: 90, border: "1px solid var(--border, #eee)", padding: 4,
                        background: day === referenceDate ? "var(--surface-2, #f5f8ff)" : undefined }}>
                        {day ? (
                          <div data-testid={`day-${day}`}>
                            <div style={{ display: "flex", justifyContent: "space-between" }}>
                              <span>{Number(day.slice(8))}</span>
                              {data.countsByDay[day] ? <span className="text-muted" data-testid={`count-${day}`}>{data.countsByDay[day]}</span> : null}
                            </div>
                            {(byDay.get(day) ?? []).slice(0, 3).map((d) => (
                              <div key={d.id} style={{ fontSize: "var(--fs-sm)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                <Link href={`/app/prazos/${d.id}`} title={`${d.title} · ${nameOf(d.responsibleId)}`}>{d.agendaTime ? `${d.agendaTime} ` : ""}{d.title}</Link>
                              </div>
                            ))}
                            {(byDay.get(day)?.length ?? 0) > 3 || (data.countsByDay[day] ?? 0) > (byDay.get(day)?.length ?? 0) ? (
                              <button type="button" className="btn btn--ghost btn--sm" onClick={() => setOpenDay(day)}
                                aria-label={`Ver todos os ${data.countsByDay[day] ?? byDay.get(day)?.length ?? 0} prazos de ${formatCivilDate(day)}`}>
                                Ver todos ({data.countsByDay[day] ?? byDay.get(day)?.length ?? 0})
                              </button>
                            ) : null}
                          </div>
                        ) : null}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
            {openDay ? (
              <Modal open title={`Prazos de ${formatCivilDate(openDay)}`} onClose={() => setOpenDay(null)}
                footer={<Button variant="secondary" onClick={() => setOpenDay(null)}>Fechar</Button>}>
                <p className="text-muted">
                  {(byDay.get(openDay) ?? []).length} de {data.countsByDay[openDay] ?? 0} prazo(s) deste dia (contagem do servidor).
                </p>
                {(data.countsByDay[openDay] ?? 0) > (byDay.get(openDay) ?? []).length ? (
                  <Notice kind="error">Nem todos os prazos deste dia puderam ser carregados. Use a lista de prazos com o filtro de vencimento para ver os demais.</Notice>
                ) : null}
                <ul aria-label={`Prazos de ${formatCivilDate(openDay)}`} style={{ listStyle: "none", padding: 0, maxHeight: "60vh", overflowY: "auto" }}>
                  {(byDay.get(openDay) ?? []).map((d) => (
                    <li key={d.id} style={{ padding: "4px 0" }}>
                      <Link href={`/app/prazos/${d.id}`}>{d.agendaTime ? `${d.agendaTime} · ` : ""}{d.title}</Link>
                      <span className="text-muted"> · {nameOf(d.responsibleId)}</span>
                    </li>
                  ))}
                </ul>
              </Modal>
            ) : null}
          </>
        );
      }}</ResourceState>
    </div>
  );
}
