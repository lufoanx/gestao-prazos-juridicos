"use client";
// Dashboard integrado: mesmo layout do protótipo, com dados REAIS do ambiente selecionado (via BFF).
// Contadores = totais do servidor; urgência e "hoje" = data de referência do servidor (nada do relógio local).
import Link from "next/link";
import {
  AlertTriangle, ArrowRight, CalendarClock, CalendarDays, CheckCircle2, Clock, FileScan, Inbox, Info, ListChecks, Plus, Upload,
} from "lucide-react";
import { Badge, Button, EmptyState } from "@/components/ui";
import { canonicalQuery } from "@/lib/integration/deadlines-client.mjs";
import { INTIMATION_LIST_PARAMS, type IntimationListParams } from "@/lib/integration/intimations-client.mjs";
import { canRegisterIntimation } from "@/lib/integration/intimation-caps.mjs";
import { formatCivilDate, parts } from "@/lib/integration/civil-date.mjs";
import {
  dashboardResourceKey, fetchDashboard, REVIEW_LIMIT, type IntegratedDashboardData,
} from "@/lib/integration/dashboard-summary.mjs";
import type { Deadline, IntimationPage } from "@/lib/integration/dto.d.mts";
import { useResource } from "./useResource";
import { ScopeGate, UrgencyBadge, useDeadlineContext } from "./deadlineShared";
import { IntimationStatusBadge, useIntimationContext } from "./intimationShared";
import { ResourceState } from "./ui";

const WEEKDAYS = ["domingo", "segunda-feira", "terça-feira", "quarta-feira", "quinta-feira", "sexta-feira", "sábado"];

function weekdayOf(civilDate: string) {
  const p = parts(civilDate);
  if (!p) return "";
  return WEEKDAYS[new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay()];
}

export function IntegratedDashboard() {
  return <ScopeGate><DashboardView /></ScopeGate>;
}

function DashboardView() {
  const { client, scope, caps, org } = useDeadlineContext();
  const res = useResource<IntegratedDashboardData>(dashboardResourceKey(scope), () => fetchDashboard(client, scope));
  const scopeName = scope === "office" ? (org.office?.name ?? "Escritório") : "Ambiente pessoal";
  const canUpload = canRegisterIntimation(scope, org.membership);

  return (
    <div>
      <div className="page-head">
        <div className="page-head__title">
          <h1 className="page-head__title-text" style={{ fontSize: "var(--fs-2xl)", fontWeight: 700, color: "var(--text-strong)", margin: 0 }}>
            Dashboard
          </h1>
          <p className="page-head__subtitle" data-testid="dashboard-subtitle">
            {scopeName}
            {res.status === "ready" ? ` · ${weekdayOf(res.data.referenceDate)}, ${formatCivilDate(res.data.referenceDate)}` : ""}
          </p>
        </div>
        <div className="page-head__actions">
          {canUpload ? (
            <Link className="btn btn--teal" href="/app/intimacoes/upload">
              <Upload size={17} aria-hidden /> Enviar intimação
            </Link>
          ) : null}
          {caps.canCreate ? (
            <Link className="btn btn--primary" href="/app/prazos/novo">
              <Plus size={17} aria-hidden /> Novo prazo
            </Link>
          ) : null}
        </div>
      </div>

      <div className="demo-banner" role="note">
        <Info size={14} aria-hidden />
        <span>
          Urgência é agrupamento visual pela data de referência do servidor, <strong>não é cálculo processual oficial</strong>.
        </span>
      </div>

      <ResourceState res={res}>{(data) => (
        data.consistent ? <Panels data={data} /> : (
          <div role="status" className="card"><div className="card__body">
            <p>O dia mudou enquanto o painel carregava. Atualize para ver os números do dia atual.</p>
            <Button variant="secondary" size="sm" onClick={res.reload}>Atualizar</Button>
          </div></div>
        )
      )}</ResourceState>
    </div>
  );
}

function Panels({ data }: { data: IntegratedDashboardData }) {
  const { urgent, urgentTotal, urgentHidden, agenda, agendaHidden, overview } = data;
  return (
    <>
      <div className="dash-grid">
        <section className="card card--accent-danger" aria-labelledby="sec-urgentes">
          <div className="card__head card__head--strong">
            <h2 className="card__title" id="sec-urgentes">
              <AlertTriangle size={18} aria-hidden /> Prazos urgentes
            </h2>
            <Badge tone={urgentTotal ? "danger" : "neutral"}>{urgentTotal}</Badge>
          </div>
          <div className="card__body card__body--flush priority-body" data-testid="urgent-list">
            {urgent.length === 0 ? (
              <EmptyState icon={<CheckCircle2 size={30} aria-hidden />} title="Nenhum prazo urgente">
                Nada vencido, para hoje ou próximo do vencimento neste ambiente.
              </EmptyState>
            ) : (
              urgent.map((d) => <UrgentRow key={d.id} d={d} referenceDate={data.referenceDate} />)
            )}
          </div>
          {urgentTotal > 0 ? (
            <div className="list-foot">
              {urgentHidden > 0 ? <span className="text-muted" style={{ marginRight: 8 }}>+{urgentHidden} não exibido(s)</span> : null}
              <Link className="btn btn--ghost btn--sm" href="/app/prazos">
                Ver todos os prazos <ArrowRight size={15} aria-hidden />
              </Link>
            </div>
          ) : null}
        </section>

        <div className="dash-col">
          <section className="card card--accent-teal" aria-labelledby="sec-agenda">
            <div className="card__head card__head--strong">
              <h2 className="card__title" id="sec-agenda">
                <CalendarDays size={18} aria-hidden /> Agenda do dia
              </h2>
              <Badge tone={overview.dueToday ? "teal" : "neutral"}>{overview.dueToday}</Badge>
            </div>
            <div className="card__body card__body--flush priority-body" data-testid="agenda-list">
              {agenda.length === 0 ? (
                <EmptyState icon={<CalendarDays size={30} aria-hidden />} title="Dia livre">
                  Nenhum prazo em aberto vence hoje.
                </EmptyState>
              ) : (
                agenda.map((d) => (
                  <Link className="agenda-item" key={d.id} href={`/app/prazos/${d.id}`}>
                    <span className="agenda-item__time">{d.agendaTime ?? "Sem horário"}</span>
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <span className="agenda-item__title" style={{ display: "block" }}>{d.title}</span>
                      <span className="agenda-item__meta">{d.caseNumber}</span>
                    </span>
                    <UrgencyBadge d={d} />
                  </Link>
                ))
              )}
              {agendaHidden > 0 ? <p className="text-muted" style={{ padding: "8px 16px" }}>+{agendaHidden} não exibido(s)</p> : null}
            </div>
          </section>

          <ReviewCard />
        </div>
      </div>

      <h2 className="overview-head">Visão geral</h2>
      <div className="stat-grid">
        <div className="stat stat--danger">
          <span className="stat__label"><AlertTriangle size={13} aria-hidden /> Vencidos</span>
          <span className="stat__value" data-testid="stat-overdue">{overview.overdue}</span>
          <span className="stat__meta">Requerem atenção imediata</span>
        </div>
        <div className="stat stat--accent">
          <span className="stat__label"><CalendarClock size={13} aria-hidden /> Vencem hoje</span>
          <span className="stat__value" data-testid="stat-today">{overview.dueToday}</span>
          <span className="stat__meta">Na agenda do dia</span>
        </div>
        <div className="stat">
          <span className="stat__label"><Clock size={13} aria-hidden /> Próximos</span>
          <span className="stat__value" data-testid="stat-soon">{overview.soon}</span>
          <span className="stat__meta">Prazos se aproximando</span>
        </div>
        <div className="stat">
          <span className="stat__label"><ListChecks size={13} aria-hidden /> Em aberto</span>
          <span className="stat__value" data-testid="stat-open">{overview.open}</span>
          <span className="stat__meta" data-testid="stat-totals">{overview.completed} concluído(s) · {overview.total} no total</span>
        </div>
      </div>
    </>
  );
}

function UrgentRow({ d, referenceDate }: { d: Deadline; referenceDate: string }) {
  const days = d.urgency?.days ?? 0;
  const rel = d.dueDate === referenceDate ? "hoje"
    : days < 0 ? `há ${-days} dia(s)` : `em ${days} dia(s)`;
  return (
    <Link className="deadline-row" href={`/app/prazos/${d.id}`}>
      <span className="deadline-row__main">
        <span className="deadline-row__title" style={{ display: "block" }}>{d.title}</span>
        <span className="deadline-row__meta">
          <span className="nowrap">{d.caseNumber}</span>
          <span className="sep" aria-hidden>·</span>
          <span className="nowrap">{d.court}</span>
          {d.priority === "high" ? <Badge tone="danger">Prioridade alta</Badge> : null}
        </span>
      </span>
      <span className="deadline-row__due">
        <span style={{ display: "block", marginBottom: 4 }}><UrgencyBadge d={d} /></span>
        <span className="deadline-row__due-date" style={{ display: "block" }}>{formatCivilDate(d.dueDate)}</span>
        <span className="deadline-row__due-rel">{rel}</span>
      </span>
    </Link>
  );
}

/** Intimações aguardando revisão: consulta própria (sem acesso a intimações não derruba o painel). */
function ReviewCard() {
  const { intimations, scope } = useIntimationContext();
  const params: IntimationListParams = { scope, status: "awaiting_review", page: 1, perPage: REVIEW_LIMIT };
  const key = `intimations?dashboard&${canonicalQuery(params as unknown as Record<string, unknown>, INTIMATION_LIST_PARAMS)}`;
  const res = useResource<IntimationPage>(key, () => intimations.list(params));
  const total = res.status === "ready" ? res.data.total : 0;
  return (
    <section className="card card--accent-warning" aria-labelledby="sec-revisao">
      <div className="card__head card__head--strong">
        <h2 className="card__title" id="sec-revisao">
          <FileScan size={18} aria-hidden /> Intimações para revisão
        </h2>
        <Badge tone={total ? "warning" : "neutral"}>{total}</Badge>
      </div>
      <div className="card__body card__body--flush priority-body" data-testid="review-list">
        <ResourceState res={res}>{(page) => (
          page.items.length === 0 ? (
            <EmptyState icon={<Inbox size={30} aria-hidden />} title="Nada para revisar">
              Nenhuma intimação aguardando revisão.
            </EmptyState>
          ) : (
            <>
              {page.items.map((i) => (
                <Link className="review-item" key={i.id} href={`/app/intimacoes/${i.id}`}>
                  <span className="review-item__icon"><FileScan size={20} aria-hidden /></span>
                  <span className="review-item__main">
                    <span className="review-item__name" style={{ display: "block" }}>{i.draft.title || i.file.name}</span>
                    <span className="review-item__meta">
                      {i.file.name} · recebida {formatCivilDate(i.receivedAt)}
                      {i.draft.dueDate ? ` · prazo informado ${formatCivilDate(i.draft.dueDate)}` : ""}
                    </span>
                  </span>
                  <IntimationStatusBadge status={i.status} />
                </Link>
              ))}
            </>
          )
        )}</ResourceState>
      </div>
      {total > 0 ? (
        <div className="list-foot">
          <Link className="btn btn--ghost btn--sm" href="/app/intimacoes">
            Abrir intimações <ArrowRight size={15} aria-hidden />
          </Link>
        </div>
      ) : null}
    </section>
  );
}
