"use client";
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useScope } from "@/context/ScopeContext";
import { useData } from "@/context/DataContext";
import { canReadDeadline } from "@/lib/access.mjs";
import { monthMatrix, groupByDueDate, matchesScope } from "@/lib/deadlines-view.mjs";
import { urgencyOf } from "@/lib/urgency.mjs";
import { getDemoToday } from "@/lib/clock.mjs";
import type { Deadline } from "@/types/domain";

const MONTHS = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];
const WD = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];

function eventClass(d: Deadline, today: string): string {
  if (d.status === "completed") return "cal__event cal__event--done";
  if (d.status === "cancelled") return "cal__event cal__event--done";
  const lvl = urgencyOf(d.dueDate, today).level;
  if (lvl === "overdue") return "cal__event cal__event--overdue";
  if (lvl === "today") return "cal__event cal__event--today";
  if (lvl === "soon") return "cal__event cal__event--soon";
  return "cal__event";
}

export default function CalendarioPage() {
  const router = useRouter();
  const { scope, scopeKind, user, membership } = useScope();
  const { deadlines } = useData();
  const today = getDemoToday();

  const [ty, tm] = today.split("-").map(Number);
  const [year, setYear] = useState(ty);
  const [month, setMonth] = useState(tm); // 1-based

  const visible = useMemo(
    () => deadlines.filter((d) => matchesScope(d, scope) && canReadDeadline(user.id, membership, d)),
    [deadlines, scope, user.id, membership]
  );
  const byDate = useMemo(() => groupByDueDate(visible), [visible]);
  const weeks = useMemo(() => monthMatrix(year, month), [year, month]);

  function prev() { if (month === 1) { setMonth(12); setYear((y) => y - 1); } else setMonth((m) => m - 1); }
  function next() { if (month === 12) { setMonth(1); setYear((y) => y + 1); } else setMonth((m) => m + 1); }
  function goToday() { setYear(ty); setMonth(tm); }

  const monthKey = String(month).padStart(2, "0");

  return (
    <div>
      <div className="page-head">
        <div className="page-head__title">
          <h1 style={{ fontSize: "var(--fs-2xl)", fontWeight: 700, color: "var(--text-strong)", margin: 0 }}>Calendário</h1>
          <p className="page-head__subtitle">{scopeKind === "office" ? "Escritório" : "Ambiente pessoal"} · vencimentos dos prazos</p>
        </div>
        <div className="page-head__actions">
          <a className="btn btn--secondary" href="/app/prazos">Ver lista</a>
        </div>
      </div>

      <div className="cal">
        <div className="cal__bar">
          <span className="cal__title">{MONTHS[month - 1]} de {year}</span>
          <div className="cal__nav">
            <button className="btn btn--ghost btn--sm" onClick={goToday}>Hoje</button>
            <button className="icon-btn" aria-label="Mês anterior" onClick={prev}><ChevronLeft size={18} aria-hidden /></button>
            <button className="icon-btn" aria-label="Próximo mês" onClick={next}><ChevronRight size={18} aria-hidden /></button>
          </div>
        </div>
        <div className="cal__weekhead" aria-hidden>
          {WD.map((w) => <span key={w}>{w}</span>)}
        </div>
        <div className="cal__grid">
          {weeks.flat().map((date) => {
            const inMonth = date.slice(0, 7) === `${year}-${monthKey}`;
            const isToday = date === today;
            const events = byDate[date] ?? [];
            const shown = events.slice(0, 3);
            const dayNum = Number(date.split("-")[2]);
            return (
              <div key={date} className={`cal__cell${inMonth ? "" : " cal__cell--out"}${isToday ? " cal__cell--today" : ""}`}>
                <span className="cal__daynum">{dayNum}</span>
                {shown.map((d) => (
                  <button key={d.id} className={eventClass(d, today)} title={`${d.title} — ${d.caseNumber}`}
                    onClick={() => router.push(`/app/prazos/${d.id}`)}>
                    {d.title}
                  </button>
                ))}
                {events.length > shown.length ? <span className="cal__more">+{events.length - shown.length} mais</span> : null}
              </div>
            );
          })}
        </div>
      </div>

      <div className="cal-legend">
        <span><i style={{ background: "var(--danger)" }} /> Vencido</span>
        <span><i style={{ background: "var(--warning)" }} /> Vence hoje</span>
        <span><i style={{ background: "var(--teal-600)" }} /> Próximo</span>
        <span><i style={{ background: "var(--navy-700)" }} /> Futuro</span>
        <span><i style={{ background: "var(--border-strong)" }} /> Concluído/cancelado</span>
      </div>
    </div>
  );
}
