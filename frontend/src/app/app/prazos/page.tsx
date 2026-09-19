"use client";
import Link from "next/link";
import { Suspense, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Plus, CalendarClock } from "lucide-react";
import { useScope } from "@/context/ScopeContext";
import { useData } from "@/context/DataContext";
import { useSettings } from "@/context/SettingsContext";
import { canReadDeadline, canManageDeadline } from "@/lib/access.mjs";
import { filterDeadlines, sortDeadlines, paginate, distinctAreas, matchesScope } from "@/lib/deadlines-view.mjs";
import { urgencyOf, URGENCY_META } from "@/lib/urgency.mjs";
import { getDemoToday } from "@/lib/clock.mjs";
import { formatCivil } from "@/lib/dates.mjs";
import { demoUsers } from "@/mocks/data";
import type { Deadline } from "@/types/domain";
import { Badge, Table, SearchField, Filters, EmptyState, Pagination } from "@/components/ui";
import type { Column } from "@/components/ui";

const STATUS_LABEL: Record<Deadline["status"], string> = { open: "Em aberto", completed: "Concluído", cancelled: "Cancelado" };
const STATUS_TONE: Record<Deadline["status"], "info" | "success" | "neutral"> = { open: "info", completed: "success", cancelled: "neutral" };
const PER_PAGE = 8;

function PrazosInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { scope, scopeKind, user, membership } = useScope();
  const { deadlines } = useData();
  const today = getDemoToday();

  const [query, setQuery] = useState(searchParams.get("q") ?? "");
  const { settings } = useSettings();
  // Busca vinda do cabeçalho (?q=): preenche o campo ao chegar/alterar o parâmetro.
  useEffect(() => {
    const q = searchParams.get("q");
    if (q !== null) setQuery(q);
  }, [searchParams]);
  const [status, setStatus] = useState<"all" | "open" | "completed" | "cancelled">(settings.showCompleted ? "all" : "open");
  const [urgency, setUrgency] = useState<"all" | "overdue" | "today" | "soon" | "upcoming">("all");
  const [area, setArea] = useState("all");
  const [page, setPage] = useState(1);

  const nameOf = useMemo(() => {
    const map = new Map<string, string>();
    demoUsers.forEach((u) => map.set(u.id, u.name));
    map.set(user.id, user.name);
    return (id: string) => map.get(id) ?? "—";
  }, [user.id, user.name]);

  // Recorte por ambiente + política de leitura (isolamento pessoal/escritório).
  const visible = useMemo(
    () => deadlines.filter((d) => matchesScope(d, scope) && canReadDeadline(user.id, membership, d)),
    [deadlines, scope, user.id, membership]
  );

  const areas = useMemo(() => distinctAreas(visible), [visible]);

  const filtered = useMemo(
    () => sortDeadlines(filterDeadlines(visible, { query, status, urgency, area, today }), "dueDate", "asc"),
    [visible, query, status, urgency, area, today]
  );
  const pageData = useMemo(() => paginate(filtered, page, PER_PAGE), [filtered, page]);

  // Volta para a primeira página quando os filtros mudam o total.
  const resetToFirst = () => setPage(1);
  const canCreate = canManageDeadline(scopeKind, membership, "deadline.create");

  const columns: Column<Deadline>[] = [
    {
      key: "title", header: "Prazo", sortValue: (d) => d.title.toLowerCase(),
      render: (d) => (
        <span>
          <span style={{ display: "block", fontWeight: 600, color: "var(--text-strong)" }}>{d.title}</span>
          <span style={{ fontSize: "var(--fs-sm)", color: "var(--muted)" }}>{d.caseNumber} · {d.court}</span>
        </span>
      ),
    },
    { key: "area", header: "Área", render: (d) => d.practiceArea, sortValue: (d) => d.practiceArea },
    { key: "resp", header: "Responsável", render: (d) => nameOf(d.responsibleId) },
    {
      key: "dueDate", header: "Vencimento", sortValue: (d) => d.dueDate,
      render: (d) => {
        if (d.status !== "open") return <span style={{ color: "var(--muted)" }}>{formatCivil(d.dueDate)}</span>;
        const meta = URGENCY_META[urgencyOf(d.dueDate, today).level];
        return (
          <span>
            <span style={{ display: "block" }}>{formatCivil(d.dueDate)}</span>
            <Badge tone={meta.tone} dot>{meta.label}</Badge>
          </span>
        );
      },
    },
    { key: "status", header: "Status", sortValue: (d) => d.status, render: (d) => <Badge tone={STATUS_TONE[d.status]}>{STATUS_LABEL[d.status]}</Badge> },
  ];

  return (
    <div>
      <div className="page-head">
        <div className="page-head__title">
          <h1 style={{ fontSize: "var(--fs-2xl)", fontWeight: 700, color: "var(--text-strong)", margin: 0 }}>Prazos</h1>
          <p className="page-head__subtitle">{scopeKind === "office" ? "Escritório" : "Ambiente pessoal"} · {visible.length} prazo(s)</p>
        </div>
        {canCreate ? (
          <div className="page-head__actions">
            <Link className="btn btn--primary" href="/app/prazos/novo"><Plus size={17} aria-hidden /> Novo prazo</Link>
          </div>
        ) : null}
      </div>

      <Filters>
        <div className="toolbar__search">
          <SearchField label="Buscar" value={query} onChange={(v) => { setQuery(v); resetToFirst(); }} placeholder="Título, processo, tribunal…" />
        </div>
        <div className="toolbar__field field">
          <label className="field__label" htmlFor="f-status">Status</label>
          <select id="f-status" className="select" value={status} onChange={(e) => { setStatus(e.target.value as typeof status); resetToFirst(); }}>
            <option value="all">Todos</option>
            <option value="open">Em aberto</option>
            <option value="completed">Concluídos</option>
            <option value="cancelled">Cancelados</option>
          </select>
        </div>
        <div className="toolbar__field field">
          <label className="field__label" htmlFor="f-urg">Urgência</label>
          <select id="f-urg" className="select" value={urgency} onChange={(e) => { setUrgency(e.target.value as typeof urgency); resetToFirst(); }}>
            <option value="all">Todas</option>
            <option value="overdue">Vencidos</option>
            <option value="today">Vencem hoje</option>
            <option value="soon">Próximos (3 dias)</option>
            <option value="upcoming">Futuros</option>
          </select>
        </div>
        <div className="toolbar__field field">
          <label className="field__label" htmlFor="f-area">Área</label>
          <select id="f-area" className="select" value={area} onChange={(e) => { setArea(e.target.value); resetToFirst(); }}>
            <option value="all">Todas</option>
            {areas.map((a) => <option key={a} value={a}>{a}</option>)}
          </select>
        </div>
      </Filters>

      <p className="result-count">{filtered.length} resultado(s){filtered.length !== visible.length ? ` de ${visible.length}` : ""}.</p>

      {filtered.length === 0 ? (
        <div className="card"><div className="card__body">
          <EmptyState icon={<CalendarClock size={30} aria-hidden />} title="Nenhum prazo encontrado">
            {visible.length === 0 ? "Ainda não há prazos neste ambiente. Cadastre o primeiro." : "Ajuste a busca ou os filtros."}
          </EmptyState>
        </div></div>
      ) : (
        <>
          <Table
            columns={columns} rows={pageData.items} rowKey={(d) => d.id}
            caption="Lista de prazos" onRowClick={(d) => router.push(`/app/prazos/${d.id}`)}
          />
          <Pagination page={pageData.page} pageCount={pageData.pageCount} onPage={setPage}
            info={`Página ${pageData.page} de ${pageData.pageCount}`} />
        </>
      )}
    </div>
  );
}

export default function PrazosPage() {
  return (
    <Suspense fallback={null}>
      <PrazosInner />
    </Suspense>
  );
}
