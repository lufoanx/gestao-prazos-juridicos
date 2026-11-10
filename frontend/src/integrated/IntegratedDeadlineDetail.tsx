"use client";
// Detalhe integrado do prazo (6.3): dados, edição com versão, status, transferência,
// comentários e histórico paginados. Nenhuma mutação é repetida automaticamente.
import { useState } from "react";
import Link from "next/link";
import { Badge, Button, ConfirmDialog, EmptyState, Modal, Pagination, Select, Textarea } from "@/components/ui";
import { canTransferToOffice, selectableResponsibles } from "@/lib/integration/deadline-caps.mjs";
import { formatCivilDate } from "@/lib/integration/civil-date.mjs";
import { describeEvent } from "@/lib/integration/history-format.mjs";
import type { CommentPage, Deadline, DeadlineStatus, HistoryPage } from "@/lib/integration/dto.d.mts";
import { DeadlineFields, draftToInput, validateDraft, type DeadlineDraft } from "./DeadlineFields";
import { useResource } from "./useResource";
import { STATUS_LABEL, STATUS_TONE, ScopeGate, UrgencyBadge, useDeadlineContext, useInvalidateDeadlines } from "./deadlineShared";
import { Card, Notice, PageHead, ResourceState, fmtDate, useMutation } from "./ui";

const DEADLINE_ID = /^[A-Za-z0-9_-]{1,64}$/;

export function IntegratedDeadlineDetail({ deadlineId, startEditing = false }: { deadlineId: string; startEditing?: boolean }) {
  if (!DEADLINE_ID.test(deadlineId)) return <Notice>Prazo não encontrado.</Notice>;
  return <ScopeGate><DetailView deadlineId={deadlineId} startEditing={startEditing} /></ScopeGate>;
}

function toDraft(d: Deadline): DeadlineDraft {
  return { title: d.title, caseNumber: d.caseNumber, court: d.court, practiceArea: d.practiceArea, responsibleId: d.responsibleId,
    priority: d.priority, startDate: d.startDate, dueDate: d.dueDate, countingMode: d.countingMode, duration: String(d.duration),
    agendaTime: d.agendaTime ?? "", reviewed: d.reviewed };
}

function DetailView({ deadlineId, startEditing }: { deadlineId: string; startEditing: boolean }) {
  const { client, nameOf } = useDeadlineContext();
  const res = useResource<Deadline>(`deadline:${deadlineId}`, () => client.get(deadlineId));
  const [editing, setEditing] = useState(startEditing);
  return (
    <ResourceState res={res}>{(d) => (
      <div>
        <PageHead title={d.title}>
          <Link className="btn btn--secondary" href="/app/prazos">Voltar à lista</Link>
        </PageHead>
        <Card>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
            <Badge tone={STATUS_TONE[d.status]}>{STATUS_LABEL[d.status]}</Badge>
            <UrgencyBadge d={d} />
            {d.priority === "high" ? <Badge tone="danger">Prioridade alta</Badge> : null}
            <Badge tone="neutral">{d.scope.kind === "office" ? "Escritório" : "Pessoal"}</Badge>
          </div>
          <dl className="detail-grid" style={{ display: "grid", gridTemplateColumns: "max-content 1fr", gap: "4px 16px", margin: 0 }}>
            <dt>Processo</dt><dd>{d.caseNumber}</dd>
            <dt>Tribunal / vara</dt><dd>{d.court}</dd>
            <dt>Área</dt><dd>{d.practiceArea}</dd>
            <dt>Responsável</dt><dd data-testid="responsible">{nameOf(d.responsibleId)}</dd>
            <dt>Início</dt><dd>{formatCivilDate(d.startDate)}</dd>
            <dt>Vencimento</dt><dd data-testid="due-date">{formatCivilDate(d.dueDate)}{d.agendaTime ? ` às ${d.agendaTime}` : ""}</dd>
            <dt>Referência</dt><dd>{d.duration} dia(s) {d.countingMode === "business" ? "úteis" : "corridos"} <span className="text-muted">(não é cálculo processual oficial)</span></dd>
            <dt>Conferido</dt><dd>{d.reviewed ? "Sim (declaração do usuário)" : "Não"}</dd>
            <dt>Criado por</dt><dd>{nameOf(d.createdBy)} em {fmtDate(d.createdAt)}</dd>
          </dl>
        </Card>
        <EditSection d={d} editing={editing} setEditing={setEditing} reload={res.reload} />
        <StatusSection d={d} reload={res.reload} />
        <TransferSection d={d} reload={res.reload} />
        <CommentsSection d={d} />
        <HistorySection d={d} />
      </div>
    )}</ResourceState>
  );
}

function EditSection({ d, editing, setEditing, reload }: { d: Deadline; editing: boolean; setEditing: (v: boolean) => void; reload: () => void }) {
  const { client, caps, scope, org, members, me, nameOf } = useDeadlineContext();
  const invalidate = useInvalidateDeadlines();
  const [draft, setDraft] = useState<DeadlineDraft>(() => toDraft(d));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [conflict, setConflict] = useState(false);
  const [ok, setOk] = useState<string | null>(null);
  const m = useMutation();
  if (!caps.canEdit) return null;

  const base = selectableResponsibles(scope === "office" && d.scope.kind === "office" ? "office" : "personal", org.membership,
    members.status === "ready" ? members.data.members : [], me!);
  const responsibles = base.some((r) => r.userId === d.responsibleId) ? base : [{ userId: d.responsibleId, name: nameOf(d.responsibleId) }, ...base];
  const lock = d.scope.kind === "personal" || org.membership?.visibility !== "all";

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setOk(null);
    const errs = validateDraft(draft);
    setErrors(errs);
    if (Object.keys(errs).length) return;
    const input = draftToInput(draft);
    const changes: Record<string, unknown> = {};
    const current = draftToInput(toDraft(d));
    const cur = current as unknown as Record<string, unknown>;
    for (const [k, v] of Object.entries(input)) if (cur[k] !== v) changes[k] = v;
    if (Object.keys(changes).length === 0) { setEditing(false); return; }
    const r = await m.run(() => client.update(d.id, d.version, changes));   // versão LIDA
    if (r.ok) { setConflict(false); setEditing(false); setOk("Alterações salvas."); invalidate(d.id); reload(); return; }
    if (r.code === "version_conflict") setConflict(true);                   // sem reenvio automático
  }

  if (!editing) {
    return (
      <Card>
        {ok ? <Notice kind="ok">{ok}</Notice> : null}
        <Button variant="secondary" onClick={() => { setDraft(toDraft(d)); setErrors({}); setConflict(false); m.clear(); setEditing(true); }}>Editar prazo</Button>
      </Card>
    );
  }
  return (
    <Card title="Editar prazo">
      <form onSubmit={save} noValidate aria-label="Editar prazo">
        <DeadlineFields draft={draft} onChange={setDraft} errors={errors} responsibles={responsibles} lockResponsible={lock} />
        {m.error ? <Notice kind="error">{m.error}</Notice> : null}
        {conflict ? (
          <div role="alert" className="field__error">
            <p>Seu rascunho foi mantido. Carregue a versão atual, revise e confirme salvando de novo.</p>
            <Button variant="secondary" size="sm" onClick={() => { invalidate(d.id); reload(); }}>Carregar versão atual (v{d.version} carregada)</Button>
          </div>
        ) : null}
        <div style={{ display: "flex", gap: 8 }}>
          <Button type="submit" disabled={m.busy}>{m.busy ? "Salvando…" : "Salvar alterações"}</Button>
          <Button variant="secondary" onClick={() => setEditing(false)}>Cancelar</Button>
        </div>
      </form>
    </Card>
  );
}

function StatusSection({ d, reload }: { d: Deadline; reload: () => void }) {
  const { client, caps, scope, org, members, me } = useDeadlineContext();
  const invalidate = useInvalidateDeadlines();
  const m = useMutation();
  const [target, setTarget] = useState<DeadlineStatus | null>(null);
  const [needResponsible, setNeedResponsible] = useState(false);
  const [newResponsible, setNewResponsible] = useState("");
  const [ok, setOk] = useState<string | null>(null);
  if (!caps.canComplete) return null;

  const candidates = selectableResponsibles(scope === "office" && d.scope.kind === "office" ? "office" : "personal", org.membership,
    members.status === "ready" ? members.data.members : [], me!).filter((c) => c.userId !== d.responsibleId);

  async function apply(status: DeadlineStatus, responsibleId?: string) {
    setOk(null);
    const r = await m.run(() => client.setStatus(d.id, d.version, status, responsibleId));
    if (r.ok) { setNeedResponsible(false); setOk(`Status: ${STATUS_LABEL[status]}.`); invalidate(d.id); reload(); return; }
    if (r.code === "responsible_inactive") setNeedResponsible(true);
  }
  const LABEL = { completed: "Concluir", cancelled: "Cancelar", open: "Reabrir" } as const;
  return (
    <Card title="Status">
      <div style={{ display: "flex", gap: 8 }}>
        {d.status === "open" ? (
          <>
            <Button disabled={m.busy} onClick={() => setTarget("completed")}>Concluir</Button>
            <Button variant="secondary" disabled={m.busy} onClick={() => setTarget("cancelled")}>Cancelar prazo</Button>
          </>
        ) : <Button variant="secondary" disabled={m.busy} onClick={() => setTarget("open")}>Reabrir</Button>}
      </div>
      {m.error ? <Notice kind="error">{m.error}</Notice> : null}
      {ok ? <Notice kind="ok">{ok}</Notice> : null}
      {needResponsible ? (
        caps.canEdit && org.membership?.visibility === "all" && candidates.length ? (
          <div style={{ marginTop: 8 }}>
            <Select label="Novo responsável" value={newResponsible} onChange={(e) => setNewResponsible(e.target.value)}>
              <option value="">Escolha um membro</option>
              {candidates.map((c) => <option key={c.userId} value={c.userId}>{c.name}</option>)}
            </Select>
            <Button disabled={!newResponsible || m.busy} onClick={() => apply("open", newResponsible)}>Reabrir com novo responsável</Button>
          </div>
        ) : <Notice>Reabrir exige escolher um novo responsável, o que pede a permissão “Editar prazos” e visibilidade de todos os prazos.</Notice>
      ) : null}
      <ConfirmDialog open={!!target} title={target ? `${LABEL[target]} prazo?` : ""} confirmLabel={target ? LABEL[target] : ""}
        danger={target === "cancelled"} cancelLabel="Voltar"
        message={target === "cancelled" ? "O prazo deixa de contar como pendente. Ele pode ser reaberto depois." : "Confirme a alteração de status."}
        onCancel={() => setTarget(null)} onConfirm={() => { const t = target; setTarget(null); if (t) void apply(t); }} />
    </Card>
  );
}

function TransferSection({ d, reload }: { d: Deadline; reload: () => void }) {
  const { client, org, scope } = useDeadlineContext();
  const invalidate = useInvalidateDeadlines();
  const m = useMutation();
  const [open, setOpen] = useState(false);
  const [consent, setConsent] = useState(false);
  const [needIntimationConsent, setNeedIntimationConsent] = useState(false);
  const [intimationConsent, setIntimationConsent] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  if (d.scope.kind !== "personal" || scope !== "personal" || !org.office || !canTransferToOffice(org.membership)) return null;

  async function submit() {
    if (!consent) { m.setError("Confirme o compartilhamento para transferir."); return; }
    if (needIntimationConsent && !intimationConsent) { m.setError("Confirme também o compartilhamento da intimação vinculada."); return; }
    const r = await m.run(() => client.transfer(d.id, d.version, org.office!.id, { shareLinkedIntimation: needIntimationConsent && intimationConsent }));
    if (r.ok) { setOpen(false); setDone(r.value.notice); invalidate(d.id); reload(); return; }
    if (r.code === "linked_intimation_requires_consent") setNeedIntimationConsent(true);   // pede confirmação ESPECÍFICA
  }
  return (
    <Card title="Transferir para o escritório">
      {done ? <Notice kind="ok">{done}</Notice> : null}
      <p className="text-muted">Move este prazo pessoal para “{org.office.name}”. O prazo deixa de ser privado.</p>
      <Button variant="secondary" onClick={() => { setOpen(true); setConsent(false); setNeedIntimationConsent(false); setIntimationConsent(false); m.clear(); }}>Transferir…</Button>
      <Modal open={open} title="Transferir prazo para o escritório?" onClose={() => setOpen(false)} footer={
        <>
          <Button variant="secondary" onClick={() => setOpen(false)}>Voltar</Button>
          <Button onClick={submit} disabled={m.busy}>{m.busy ? "Transferindo…" : "Transferir"}</Button>
        </>
      }>
        <p>Depois da transferência, <strong>comentários e histórico deste prazo passam a ser visíveis</strong> a quem tiver acesso a ele no
          escritório. Você continua como responsável. A operação não pode ser desfeita por aqui.</p>
        <label style={{ display: "block" }}><input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} /> Entendo e quero compartilhar comentários e histórico com o escritório</label>
        {needIntimationConsent ? (
          <label style={{ display: "block", marginTop: 8 }}>
            <input type="checkbox" checked={intimationConsent} onChange={(e) => setIntimationConsent(e.target.checked)} />{" "}
            Este prazo tem uma <strong>intimação vinculada</strong>; ela e seus dados também serão compartilhados com o escritório
          </label>
        ) : null}
        {m.error ? <Notice kind="error">{m.error}</Notice> : null}
      </Modal>
    </Card>
  );
}

function CommentsSection({ d }: { d: Deadline }) {
  const { client, caps, nameOf } = useDeadlineContext();
  const [page, setPage] = useState(1);
  const res = useResource<CommentPage>(`deadline:${d.id}:comments:p${page}`, () => client.comments(d.id, page, 20));
  const [text, setText] = useState("");
  const [unknown, setUnknown] = useState(false);
  const m = useMutation();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const t = text.trim();
    if (!t || t.length > 2000) { m.setError("Comentário: 1 a 2000 caracteres."); return; }
    setUnknown(false);
    const r = await m.run(() => client.addComment(d.id, t));          // um envio por clique, nunca repetido
    if (r.ok) { setText(""); res.reload(); return; }
    if (r.unknownOutcome) setUnknown(true);                           // mantém o texto; pede conferência
  }
  return (
    <Card title="Comentários">
      <ResourceState res={res}>{(data) => (
        <>
          {data.items.length === 0 ? <EmptyState title="Nenhum comentário." /> : (
            <ul aria-label="Comentários" style={{ listStyle: "none", padding: 0 }}>
              {data.items.map((c) => (
                <li key={c.id} style={{ padding: "6px 0" }}>
                  <strong>{nameOf(c.authorId)}</strong> <span className="text-muted">{fmtDate(c.createdAt)}</span>
                  <div style={{ whiteSpace: "pre-wrap" }}>{c.text}</div>
                </li>
              ))}
            </ul>
          )}
          <Pagination page={data.page} pageCount={Math.max(1, Math.ceil(data.total / data.perPage))} onPage={setPage} />
        </>
      )}</ResourceState>
      {caps.canComment ? (
        <form onSubmit={submit} noValidate aria-label="Adicionar comentário">
          <Textarea label="Novo comentário" value={text} maxLength={2000} onChange={(e) => setText(e.target.value)} />
          {m.error ? <Notice kind="error">{m.error}</Notice> : null}
          {unknown ? <Button variant="secondary" size="sm" onClick={() => { setUnknown(false); m.clear(); res.reload(); }}>Conferir comentários</Button> : null}
          <Button type="submit" disabled={m.busy}>{m.busy ? "Enviando…" : "Comentar"}</Button>
        </form>
      ) : null}
    </Card>
  );
}

function HistorySection({ d }: { d: Deadline }) {
  const { client, nameOf } = useDeadlineContext();
  const [page, setPage] = useState(1);
  const res = useResource<HistoryPage>(`deadline:${d.id}:history:p${page}:v${d.version}`, () => client.history(d.id, page, 20));
  return (
    <Card title="Histórico">
      <ResourceState res={res}>{(data) => (
        <>
          <ul aria-label="Histórico" style={{ listStyle: "none", padding: 0 }}>
            {data.items.map((e) => (
              <li key={e.id} style={{ padding: "4px 0" }}>
                <span className="text-muted">{fmtDate(e.at)}</span> · <strong>{nameOf(e.actorId)}</strong>: {describeEvent(e, (u) => nameOf(u))}
              </li>
            ))}
          </ul>
          <Pagination page={data.page} pageCount={Math.max(1, Math.ceil(data.total / data.perPage))} onPage={setPage} />
        </>
      )}</ResourceState>
    </Card>
  );
}
