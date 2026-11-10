"use client";
// Lista integrada de prazos (6.3): busca, filtros, ordenação e paginação DO SERVIDOR.
// Totais e urgência vêm da resposta; nada é calculado com relógio local nem a partir de página parcial.
import { useEffect, useState } from "react";
import Link from "next/link";
import { Plus } from "lucide-react";
import { Badge, EmptyState, Filters, Pagination, SearchField, Table, type Column } from "@/components/ui";
import { canonicalQuery, LIST_PARAMS, type ListParams } from "@/lib/integration/deadlines-client.mjs";
import { formatCivilDate, isCivilDate } from "@/lib/integration/civil-date.mjs";
import type { Deadline, DeadlinePage } from "@/lib/integration/dto.d.mts";
import { useResource } from "./useResource";
import { STATUS_LABEL, STATUS_TONE, ScopeGate, UrgencyBadge, useDeadlineContext } from "./deadlineShared";
import { ResourceState } from "./ui";

export function IntegratedDeadlineList() {
  return <ScopeGate><ListView /></ScopeGate>;
}

function ListView() {
  const { client, scope, caps, nameOf } = useDeadlineContext();
  const [qInput, setQInput] = useState("");
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<"" | "open" | "completed" | "cancelled">("open");
  const [urgency, setUrgency] = useState<"" | "overdue" | "today" | "soon" | "upcoming">("");
  const [area, setArea] = useState("");
  const [dueFrom, setDueFrom] = useState("");
  const [dueTo, setDueTo] = useState("");
  const [sort, setSort] = useState<NonNullable<ListParams["sort"]>>("dueDate");
  const [dir, setDir] = useState<"asc" | "desc">("asc");
  const [page, setPage] = useState(1);

  useEffect(() => {                                            // busca com atraso curto (não a cada tecla)
    const next = qInput.trim();
    if (next === q) return;                                    // só volta à página 1 se a busca mudou
    const t = setTimeout(() => { setQ(next); setPage(1); }, 300);
    return () => clearTimeout(t);
  }, [qInput, q]);

  const params: ListParams = {
    scope, q: q || undefined, status, urgency, area: area.trim() || undefined,
    dueFrom: isCivilDate(dueFrom) ? dueFrom : undefined, dueTo: isCivilDate(dueTo) ? dueTo : undefined,
    sort, dir, page, perPage: 20,
  };
  const query = canonicalQuery(params as unknown as Record<string, unknown>, LIST_PARAMS);
  const res = useResource<DeadlinePage>(`deadlines?${query}`, () => client.list(params));
  const reset = () => setPage(1);

  const columns: Column<Deadline>[] = [
    { key: "title", header: "Prazo", render: (d) => <Link href={`/app/prazos/${d.id}`}>{d.title}</Link> },
    { key: "case", header: "Processo", render: (d) => d.caseNumber },
    { key: "due", header: "Vencimento", render: (d) => `${formatCivilDate(d.dueDate)}${d.agendaTime ? ` ${d.agendaTime}` : ""}` },
    { key: "urgency", header: "Urgência", render: (d) => <UrgencyBadge d={d} /> },
    { key: "resp", header: "Responsável", render: (d) => nameOf(d.responsibleId) },
    { key: "status", header: "Status", render: (d) => <Badge tone={STATUS_TONE[d.status]}>{STATUS_LABEL[d.status]}</Badge> },
  ];

  return (
    <div>
      <div className="page-head">
        <div className="page-head__title">
          <h1 style={{ fontSize: "var(--fs-2xl)", fontWeight: 700, margin: 0 }}>Prazos</h1>
          <p className="page-head__subtitle">{scope === "office" ? "Escritório" : "Ambiente pessoal"}</p>
        </div>
        {caps.canCreate ? (
          <div className="page-head__actions">
            <Link className="btn btn--primary" href="/app/prazos/novo"><Plus size={17} aria-hidden /> Novo prazo</Link>
          </div>
        ) : null}
      </div>
      <Filters>
        <div className="toolbar__search">
          <SearchField label="Buscar" value={qInput} onChange={setQInput} placeholder="Título, processo, tribunal, área…" />
        </div>
        <div className="toolbar__field field">
          <label className="field__label" htmlFor="f-status">Status</label>
          <select id="f-status" className="select" value={status} onChange={(e) => { setStatus(e.target.value as typeof status); reset(); }}>
            <option value="">Todos</option><option value="open">Em aberto</option>
            <option value="completed">Concluídos</option><option value="cancelled">Cancelados</option>
          </select>
        </div>
        <div className="toolbar__field field">
          <label className="field__label" htmlFor="f-urg">Urgência</label>
          <select id="f-urg" className="select" value={urgency} onChange={(e) => { setUrgency(e.target.value as typeof urgency); reset(); }}>
            <option value="">Todas</option><option value="overdue">Vencidos</option><option value="today">Vencem hoje</option>
            <option value="soon">Próximos</option><option value="upcoming">Futuros</option>
          </select>
        </div>
        <div className="toolbar__field field">
          <label className="field__label" htmlFor="f-area">Área</label>
          <input id="f-area" className="input" value={area} maxLength={60} onChange={(e) => { setArea(e.target.value); reset(); }} />
        </div>
        <div className="toolbar__field field">
          <label className="field__label" htmlFor="f-from">Vence de</label>
          <input id="f-from" type="date" className="input" value={dueFrom} onChange={(e) => { setDueFrom(e.target.value); reset(); }} />
        </div>
        <div className="toolbar__field field">
          <label className="field__label" htmlFor="f-to">até</label>
          <input id="f-to" type="date" className="input" value={dueTo} onChange={(e) => { setDueTo(e.target.value); reset(); }} />
        </div>
        <div className="toolbar__field field">
          <label className="field__label" htmlFor="f-sort">Ordenar por</label>
          <select id="f-sort" className="select" value={sort} onChange={(e) => { setSort(e.target.value as typeof sort); reset(); }}>
            <option value="dueDate">Vencimento</option><option value="title">Título</option><option value="priority">Prioridade</option>
            <option value="status">Status</option><option value="createdAt">Criação</option>
          </select>
        </div>
        <div className="toolbar__field field">
          <label className="field__label" htmlFor="f-dir">Ordem</label>
          <select id="f-dir" className="select" value={dir} onChange={(e) => { setDir(e.target.value as typeof dir); reset(); }}>
            <option value="asc">Crescente</option><option value="desc">Decrescente</option>
          </select>
        </div>
      </Filters>
      <ResourceState res={res}>{(data) => (
        <>
          <p className="result-count" data-testid="result-count">
            {data.total} resultado(s) · referência do servidor: {formatCivilDate(data.referenceDate)}
          </p>
          <div className="card"><div className="card__body">
            {data.items.length === 0 ? <EmptyState title="Nenhum prazo encontrado." /> : (
              <Table columns={columns} rows={data.items} rowKey={(d) => d.id} caption="Prazos" />
            )}
            <Pagination page={data.page} pageCount={data.pageCount} onPage={setPage}
              info={`Página ${data.page} de ${data.pageCount}`} />
          </div></div>
        </>
      )}</ResourceState>
    </div>
  );
}
