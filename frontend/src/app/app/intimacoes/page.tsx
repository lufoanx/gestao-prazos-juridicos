"use client";
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Upload, Inbox } from "lucide-react";
import { useScope } from "@/context/ScopeContext";
import { useData } from "@/context/DataContext";
import { canAccessIntimation } from "@/lib/deadline-guards.mjs";
import { canManageDeadline } from "@/lib/access.mjs";
import { formatCivil } from "@/lib/dates.mjs";
import type { Intimation } from "@/types/domain";
import { Badge, Table, SearchField, Filters, EmptyState } from "@/components/ui";
import type { Column } from "@/components/ui";

const STATUS_LABEL: Record<Intimation["status"], string> = {
  sent: "Enviada", processing: "Processando", awaiting_review: "Aguardando revisão", reviewed: "Revisada", failed: "Falha",
};
const STATUS_TONE: Record<Intimation["status"], "neutral" | "info" | "warning" | "success" | "danger"> = {
  sent: "neutral", processing: "info", awaiting_review: "warning", reviewed: "success", failed: "danger",
};

export default function IntimacoesPage() {
  const router = useRouter();
  const { scope, scopeKind, user, membership } = useScope();
  const { intimations } = useData();
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("all");

  const ctx = useMemo(() => ({ scope, scopeKind, userId: user.id, membership }), [scope, scopeKind, user.id, membership]);
  const visible = useMemo(
    () => intimations.filter((i) => canAccessIntimation(i, ctx)),
    [intimations, ctx]
  );
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return visible
      .filter((i) => (status === "all" ? true : i.status === status))
      .filter((i) => (q ? i.fileName.toLowerCase().includes(q) : true))
      .sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
  }, [visible, query, status]);

  const canUpload = canManageDeadline(scopeKind, membership, "deadline.create");

  function go(i: Intimation) {
    if (i.status === "awaiting_review") router.push(`/app/intimacoes/${i.id}/revisao`);
    else if (i.status === "reviewed" && i.deadlineId) router.push(`/app/prazos/${i.deadlineId}`);
    else if (i.status === "failed") router.push(`/app/intimacoes/${i.id}/revisao`);
  }

  const columns: Column<Intimation>[] = [
    { key: "file", header: "Arquivo", sortValue: (i) => i.fileName.toLowerCase(),
      render: (i) => <span style={{ fontWeight: 600, color: "var(--text-strong)" }}>{i.fileName}</span> },
    { key: "received", header: "Recebida", sortValue: (i) => i.receivedAt, render: (i) => formatCivil(i.receivedAt) },
    { key: "status", header: "Status", sortValue: (i) => i.status, render: (i) => <Badge tone={STATUS_TONE[i.status]}>{STATUS_LABEL[i.status]}</Badge> },
    { key: "action", header: "Ação", render: (i) => {
        if (i.status === "awaiting_review") return <span style={{ color: "var(--teal-700)", fontWeight: 600 }}>Revisar</span>;
        if (i.status === "reviewed") return <span style={{ color: "var(--muted)" }}>Ver prazo</span>;
        if (i.status === "failed") return <span style={{ color: "var(--danger-text)", fontWeight: 600 }}>Reprocessar</span>;
        if (i.status === "processing") return <span style={{ color: "var(--muted)" }}>Processando…</span>;
        return "—";
      } },
  ];

  return (
    <div>
      <div className="page-head">
        <div className="page-head__title">
          <h1 style={{ fontSize: "var(--fs-2xl)", fontWeight: 700, color: "var(--text-strong)", margin: 0 }}>Intimações</h1>
          <p className="page-head__subtitle">{scopeKind === "office" ? "Escritório" : "Ambiente pessoal"} · {visible.length} intimação(ões)</p>
        </div>
        {canUpload ? (
          <div className="page-head__actions">
            <a className="btn btn--primary" href="/app/intimacoes/upload"><Upload size={17} aria-hidden /> Enviar intimação</a>
          </div>
        ) : null}
      </div>

      <div className="form-note" style={{ marginBottom: 16 }}>
        <Inbox size={16} aria-hidden />
        <span>Processamento <strong>simulado</strong>: os dados sugeridos não são extraídos do PDF e exigem conferência humana antes de virar prazo.</span>
      </div>

      <Filters>
        <div className="toolbar__search">
          <SearchField label="Buscar" value={query} onChange={setQuery} placeholder="Nome do arquivo…" />
        </div>
        <div className="toolbar__field field">
          <label className="field__label" htmlFor="f-st">Status</label>
          <select id="f-st" className="select" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="all">Todos</option>
            <option value="processing">Processando</option>
            <option value="awaiting_review">Aguardando revisão</option>
            <option value="reviewed">Revisadas</option>
            <option value="failed">Falha</option>
          </select>
        </div>
      </Filters>

      {filtered.length === 0 ? (
        <div className="card"><div className="card__body">
          <EmptyState icon={<Inbox size={30} aria-hidden />} title="Nenhuma intimação">
            {visible.length === 0 ? "Envie um PDF (demonstrativo) para começar." : "Ajuste a busca ou o filtro."}
          </EmptyState>
        </div></div>
      ) : (
        <Table columns={columns} rows={filtered} rowKey={(i) => i.id} caption="Lista de intimações" onRowClick={go} />
      )}
    </div>
  );
}
