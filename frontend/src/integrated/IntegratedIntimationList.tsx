"use client";
// Lista integrada de intimações (6.4): busca, status e paginação DO SERVIDOR.
import { useEffect, useState } from "react";
import Link from "next/link";
import { Plus } from "lucide-react";
import { EmptyState, Filters, Pagination, SearchField, Table, type Column } from "@/components/ui";
import { canonicalQuery } from "@/lib/integration/deadlines-client.mjs";
import { INTIMATION_LIST_PARAMS, type IntimationListParams } from "@/lib/integration/intimations-client.mjs";
import { canRegisterIntimation } from "@/lib/integration/intimation-caps.mjs";
import { formatCivilDate } from "@/lib/integration/civil-date.mjs";
import type { Intimation, IntimationPage } from "@/lib/integration/dto.d.mts";
import { useResource } from "./useResource";
import { ScopeGate } from "./deadlineShared";
import { IntimationStatusBadge, MetadataOnlyNotice, useIntimationContext } from "./intimationShared";
import { ResourceState } from "./ui";

export function IntegratedIntimationList() {
  return <ScopeGate><ListView /></ScopeGate>;
}

function ListView() {
  const { intimations, scope, org, nameOf } = useIntimationContext();
  const [qInput, setQInput] = useState("");
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<NonNullable<IntimationListParams["status"]>>("");
  const [page, setPage] = useState(1);
  useEffect(() => {
    const next = qInput.trim();
    if (next === q) return;
    const t = setTimeout(() => { setQ(next); setPage(1); }, 300);
    return () => clearTimeout(t);
  }, [qInput, q]);

  const params: IntimationListParams = { scope, status, q: q || undefined, page, perPage: 20 };
  const query = canonicalQuery(params as unknown as Record<string, unknown>, INTIMATION_LIST_PARAMS);
  const res = useResource<IntimationPage>(`intimations?${query}`, () => intimations.list(params));

  const columns: Column<Intimation>[] = [
    { key: "file", header: "Intimação", render: (i) => <Link href={`/app/intimacoes/${i.id}`}>{i.draft.title || i.file.name}</Link> },
    { key: "received", header: "Recebida em", render: (i) => formatCivilDate(i.receivedAt) },
    { key: "status", header: "Status", render: (i) => <IntimationStatusBadge status={i.status} /> },
    { key: "suggested", header: "Responsável sugerido", render: (i) => (i.suggestedResponsibleId ? nameOf(i.suggestedResponsibleId) : "—") },
  ];
  return (
    <div>
      <div className="page-head">
        <div className="page-head__title">
          <h1 style={{ fontSize: "var(--fs-2xl)", fontWeight: 700, margin: 0 }}>Intimações</h1>
          <p className="page-head__subtitle">{scope === "office" ? "Escritório" : "Ambiente pessoal"}</p>
        </div>
        {canRegisterIntimation(scope, org.membership) ? (
          <div className="page-head__actions">
            <Link className="btn btn--primary" href="/app/intimacoes/upload"><Plus size={17} aria-hidden /> Registrar intimação</Link>
          </div>
        ) : null}
      </div>
      <MetadataOnlyNotice />
      <Filters>
        <div className="toolbar__search">
          <SearchField label="Buscar" value={qInput} onChange={setQInput} placeholder="Nome do arquivo, título, processo…" />
        </div>
        <div className="toolbar__field field">
          <label className="field__label" htmlFor="i-status">Status</label>
          <select id="i-status" className="select" value={status} onChange={(e) => { setStatus(e.target.value as typeof status); setPage(1); }}>
            <option value="">Todas (exceto descartadas)</option>
            <option value="awaiting_review">Aguardando revisão</option><option value="reviewed">Revisadas</option>
            <option value="discarded">Descartadas</option><option value="processing">Em processamento</option><option value="failed">Com falha</option>
          </select>
        </div>
      </Filters>
      <ResourceState res={res}>{(data) => {
        const pageCount = Math.max(1, Math.ceil(data.total / data.perPage));
        return (
          <>
            <p className="result-count" data-testid="intimation-count">{data.total} intimação(ões)</p>
            <div className="card"><div className="card__body">
              {data.items.length === 0 ? <EmptyState title="Nenhuma intimação encontrada." /> : (
                <Table columns={columns} rows={data.items} rowKey={(i) => i.id} caption="Intimações" />
              )}
              <Pagination page={data.page} pageCount={pageCount} onPage={setPage} info={`Página ${data.page} de ${pageCount}`} />
            </div></div>
          </>
        );
      }}</ResourceState>
    </div>
  );
}
