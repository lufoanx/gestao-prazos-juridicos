"use client";
import Link from "next/link";
import { useMemo } from "react";
import {
  AlertTriangle, CalendarClock, CalendarDays, FileScan, ListChecks,
  Info, CheckCircle2, Clock, Inbox, ArrowRight, Plus, Upload, Building2,
} from "lucide-react";
import { useScope } from "@/context/ScopeContext";
import { useData } from "@/context/DataContext";
import { canReadDeadline } from "@/lib/access.mjs";
import { canAccessIntimation } from "@/lib/deadline-guards.mjs";
import { buildDashboard } from "@/lib/dashboard.mjs";
import { getDemoToday } from "@/lib/clock.mjs";
import { URGENCY_META } from "@/lib/urgency.mjs";
import { formatCivil, formatShort, relativeToToday, weekdayName } from "@/lib/dates.mjs";
import type { Scope, Intimation } from "@/types/domain";
import type { AnnotatedDeadline } from "@/lib/dashboard.mjs";
import { Badge, EmptyState } from "@/components/ui";

function inScope<T extends { scope: Scope }>(rec: T, scope: Scope) {
  if (rec.scope.kind !== scope.kind) return false;
  if (rec.scope.kind === "personal" && scope.kind === "personal") return rec.scope.ownerId === scope.ownerId;
  if (rec.scope.kind === "office" && scope.kind === "office") return rec.scope.officeId === scope.officeId;
  return false;
}

const REVIEW_META: Record<Intimation["status"], { label: string; tone: "warning" | "info" | "danger" | "neutral" }> = {
  sent: { label: "Recebida", tone: "neutral" },
  processing: { label: "Processando (simulado)", tone: "info" },
  awaiting_review: { label: "Revisão obrigatória", tone: "warning" },
  reviewed: { label: "Revisada", tone: "neutral" },
  failed: { label: "Falha na leitura", tone: "danger" },
};

export function DashboardView() {
  const { scope, scopeKind, user, membership, office } = useScope();
  const { deadlines: allDeadlines, intimations: allIntimations } = useData();
  const today = getDemoToday();

  const data = useMemo(() => {
    // Recorte por ambiente + política de leitura demonstrativa (não é segurança real).
    const deadlines = allDeadlines
      .filter((d) => inScope(d, scope))
      .filter((d) => canReadDeadline(user.id, membership, d));
    // Intimações seguem a MESMA política das telas de intimações/assistente:
    // isolamento por ambiente + permissão + visibilidade (com uploader e responsável do
    // prazo vinculado). Usuário sem permissão não vê arquivo/título/data nem contadores.
    const gctx = { scope, scopeKind, userId: user.id, membership };
    const responsibleOf = (deadlineId: string) => allDeadlines.find((d) => d.id === deadlineId)?.responsibleId;
    const intimations = allIntimations.filter((i) => canAccessIntimation(i, gctx, responsibleOf));
    return buildDashboard(deadlines, intimations, today);
  }, [allDeadlines, allIntimations, scope, scopeKind, user.id, membership, today]);

  const { urgent, agenda, reviews, overview } = data;
  const scopeName = scopeKind === "office"
    ? (office?.name ?? "Escritório")
    : `Ambiente pessoal de ${user.name.split(" ")[0]}`;

  // Gestão de escritório: só no ambiente de escritório e com permissão de gerência.
  const canManageOffice = scopeKind === "office" && !!membership &&
    (membership.permissions.includes("office.manage") || membership.permissions.includes("team.manage"));

  return (
    <div>
      <div className="page-head">
        <div className="page-head__title">
          <h1 className="page-head__title-text" style={{ fontSize: "var(--fs-2xl)", fontWeight: 700, color: "var(--text-strong)", margin: 0 }}>
            Dashboard
          </h1>
          <p className="page-head__subtitle">
            {scopeName} · {weekdayName(today)}, {formatCivil(today)}
          </p>
        </div>
        <div className="page-head__actions">
          {canManageOffice ? (
            <Link className="btn btn--secondary" href="/app/escritorio">
              <Building2 size={17} aria-hidden /> Gerenciar escritório
            </Link>
          ) : null}
          <Link className="btn btn--teal" href="/app/intimacoes/upload">
            <Upload size={17} aria-hidden /> Enviar intimação
          </Link>
          <Link className="btn btn--primary" href="/app/prazos/novo">
            <Plus size={17} aria-hidden /> Novo prazo
          </Link>
        </div>
      </div>

      <div className="demo-banner" role="note">
        <Info size={14} aria-hidden />
        <span>
          <strong>Modo demonstrativo</strong> · dados fictícios · urgência é agrupamento visual, não cálculo processual oficial · sem IA/e-mail/leitura real de PDF.
        </span>
      </div>

      {/* ---------- Banda de prioridade: urgentes (2/3) + pilha lateral (1/3) ---------- */}
      <div className="dash-grid">
        {/* Urgentes */}
        <section className="card card--accent-danger" aria-labelledby="sec-urgentes">
          <div className="card__head card__head--strong">
            <h2 className="card__title" id="sec-urgentes">
              <AlertTriangle size={18} aria-hidden /> Prazos urgentes
            </h2>
            <Badge tone={urgent.length ? "danger" : "neutral"}>{urgent.length}</Badge>
          </div>
          <div className="card__body card__body--flush priority-body">
            {urgent.length === 0 ? (
              <EmptyState icon={<CheckCircle2 size={30} aria-hidden />} title="Nenhum prazo urgente">
                Nada vencido, para hoje ou nos próximos 3 dias neste ambiente.
              </EmptyState>
            ) : (
              urgent.map((d) => <UrgentRow key={d.id} d={d} today={today} />)
            )}
          </div>
          {urgent.length > 0 ? (
            <div className="list-foot">
              <Link className="btn btn--ghost btn--sm" href="/app/prazos">
                Ver todos os prazos <ArrowRight size={15} aria-hidden />
              </Link>
            </div>
          ) : null}
        </section>

        {/* Pilha lateral: agenda do dia + intimações para revisão */}
        <div className="dash-col">
        {/* Agenda do dia */}
        <section className="card card--accent-teal" aria-labelledby="sec-agenda">
          <div className="card__head card__head--strong">
            <h2 className="card__title" id="sec-agenda">
              <CalendarDays size={18} aria-hidden /> Agenda do dia
            </h2>
            <Badge tone={agenda.length ? "teal" : "neutral"}>{agenda.length}</Badge>
          </div>
          <div className="card__body card__body--flush priority-body">
            {agenda.length === 0 ? (
              <EmptyState icon={<CalendarDays size={30} aria-hidden />} title="Dia livre">
                Nenhum prazo com vencimento hoje.
              </EmptyState>
            ) : (
              agenda.map((d) => (
                <div className="agenda-item" key={d.id}>
                  <span className="agenda-item__time">{d.agendaTime ?? "Sem horário"}</span>
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span className="agenda-item__title" style={{ display: "block" }}>{d.title}</span>
                    <span className="agenda-item__meta">{d.caseNumber}</span>
                  </span>
                  <Badge tone={URGENCY_META[d.urgency.level].tone}>{URGENCY_META[d.urgency.level].label}</Badge>
                </div>
              ))
            )}
          </div>
        </section>

        {/* Intimações para revisão */}
        <section className="card card--accent-warning" aria-labelledby="sec-revisao">
          <div className="card__head card__head--strong">
            <h2 className="card__title" id="sec-revisao">
              <FileScan size={18} aria-hidden /> Intimações para revisão
            </h2>
            <Badge tone={overview.awaitingReview ? "warning" : "neutral"}>{overview.awaitingReview}</Badge>
          </div>
          <div className="card__body card__body--flush priority-body">
            {reviews.length === 0 ? (
              <EmptyState icon={<Inbox size={30} aria-hidden />} title="Nada para revisar">
                Nenhuma intimação aguardando revisão.
              </EmptyState>
            ) : (
              reviews.map((i) => (
                <Link className="review-item" key={i.id} href="/app/intimacoes">
                  <span className="review-item__icon"><FileScan size={20} aria-hidden /></span>
                  <span className="review-item__main">
                    <span className="review-item__name" style={{ display: "block" }}>
                      {i.suggestedTitle ?? i.fileName}
                    </span>
                    <span className="review-item__meta">
                      {i.fileName} · recebida {formatShort(i.receivedAt)}
                      {i.suggestedDueDate ? ` · prazo sugerido ${formatShort(i.suggestedDueDate)}` : ""}
                    </span>
                  </span>
                  <Badge tone={REVIEW_META[i.status].tone}>{REVIEW_META[i.status].label}</Badge>
                </Link>
              ))
            )}
          </div>
          {reviews.length > 0 ? (
            <div className="list-foot">
              <Link className="btn btn--ghost btn--sm" href="/app/intimacoes">
                Abrir intimações <ArrowRight size={15} aria-hidden />
              </Link>
            </div>
          ) : null}
        </section>
        </div>
      </div>

      {/* ---------- Visão geral (secundária; contadores das mesmas listas) ---------- */}
      <h2 className="overview-head">Visão geral</h2>
      <div className="stat-grid">
        <div className="stat stat--danger">
          <span className="stat__label"><AlertTriangle size={13} aria-hidden /> Vencidos</span>
          <span className="stat__value">{overview.overdue}</span>
          <span className="stat__meta">Requerem atenção imediata</span>
        </div>
        <div className="stat stat--accent">
          <span className="stat__label"><CalendarClock size={13} aria-hidden /> Vencem hoje</span>
          <span className="stat__value">{overview.dueToday}</span>
          <span className="stat__meta">Na agenda do dia</span>
        </div>
        <div className="stat">
          <span className="stat__label"><Clock size={13} aria-hidden /> Próximos (3 dias)</span>
          <span className="stat__value">{overview.soon}</span>
          <span className="stat__meta">Prazos se aproximando</span>
        </div>
        <div className="stat">
          <span className="stat__label"><ListChecks size={13} aria-hidden /> Em aberto</span>
          <span className="stat__value">{overview.open}</span>
          <span className="stat__meta">{overview.completed} concluídos · {overview.total} no total</span>
        </div>
      </div>
    </div>
  );
}

function UrgentRow({ d, today }: { d: AnnotatedDeadline; today: string }) {
  const meta = URGENCY_META[d.urgency.level];
  return (
    <Link className="deadline-row" href="/app/prazos">
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
        <span style={{ display: "block", marginBottom: 4 }}>
          <Badge tone={meta.tone} dot>{meta.label}</Badge>
        </span>
        <span className="deadline-row__due-date" style={{ display: "block" }}>{formatCivil(d.dueDate)}</span>
        <span className="deadline-row__due-rel">{relativeToToday(d.dueDate, today)}</span>
      </span>
    </Link>
  );
}
