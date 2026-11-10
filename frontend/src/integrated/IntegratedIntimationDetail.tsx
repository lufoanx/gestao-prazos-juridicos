"use client";
// Detalhe integrado da intimação (6.4). Ordem: confere o AMBIENTE real do recurso → metadados
// (sem arquivo, sem processamento) → rascunho → revisão humana e confirmação → descarte → histórico.
// Nenhuma mutação é repetida automaticamente; conflitos preservam o que a pessoa digitou.
import { useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { Button, ConfirmDialog, Input, Pagination, Select } from "@/components/ui";
import { selectableResponsibles } from "@/lib/integration/deadline-caps.mjs";
import { draftChanges, intimationCaps, linkedDeadline, scopeMatches } from "@/lib/integration/intimation-caps.mjs";
import { formatCivilDate, isCivilDate } from "@/lib/integration/civil-date.mjs";
import { describeIntimationEvent } from "@/lib/integration/history-format.mjs";
import type { Intimation, IntimationEventPage } from "@/lib/integration/dto.d.mts";
import { DeadlineFields, draftToInput, validateDraft, type DeadlineDraft } from "./DeadlineFields";
import { useResource } from "./useResource";
import { ScopeGate, ScopeMismatchNotice, useInvalidateDeadlines } from "./deadlineShared";
import { IntimationStatusBadge, MetadataOnlyNotice, announceNotificationsChanged, formatBytes, useIntimationContext } from "./intimationShared";
import { Card, Notice, PageHead, ResourceState, fmtDate, useMutation } from "./ui";
import { useOrg } from "./OrgProvider";
import { cacheKey } from "@/lib/integration/query-cache.mjs";

const ID = /^[A-Za-z0-9_-]{1,64}$/;

export function IntegratedIntimationRoute() {
  const params = useParams<{ id: string }>();
  const id = String(params?.id ?? "");
  if (!ID.test(id)) return <Notice>Intimação não encontrada.</Notice>;
  return <ScopeGate><DetailView intimationId={id} /></ScopeGate>;
}

/** Invalida listas de intimações/prazos e o recurso, na chave atual (usuário/escritório/ambiente/revisão). */
function useInvalidateIntimation() {
  const { cache, state } = useOrg();
  const invalidateDeadlines = useInvalidateDeadlines();
  return (intimationId: string) => {
    if (!state.userId) return;
    const base = { userId: state.userId, officeId: state.office?.id ?? null, scope: state.scope, revision: state.revision };
    for (const r of ["intimations", `intimation:${intimationId}`]) cache.invalidate(cacheKey(base, r));
    invalidateDeadlines();
  };
}

function DetailView({ intimationId }: { intimationId: string }) {
  const { intimations, org, me, nameOf } = useIntimationContext();
  const ctx = { scope: org.scope, officeId: org.office?.id ?? null, userId: me?.id ?? null };
  const res = useResource<Intimation>(`intimation:${intimationId}`, () => intimations.get(intimationId), { accept: (i) => scopeMatches(i, ctx) });
  // Resultado da confirmação fica AQUI (sobrevive à recarga), mas guarda SÓ o texto: o link ao
  // prazo vem sempre da projeção atual (`linkedDeadline(i)`), nunca do id da resposta anterior.
  const [result, setResult] = useState<{ kind: "ok" | "info" | "error"; text: string } | null>(null);
  if (res.status === "mismatch") return <ScopeMismatchNotice resourceScope={res.data.scope} noun="Intimação" listHref="/app/intimacoes" />;
  return (
    <ResourceState res={res}>{(i) => {
      const caps = intimationCaps(i, org.membership, me?.id ?? null);
      const link = linkedDeadline(i);
      return (
        <div>
          <PageHead title={i.draft.title || i.file.name}>
            <Link className="btn btn--secondary" href="/app/intimacoes">Voltar à lista</Link>
          </PageHead>
          {result ? (
            <p role={result.kind === "error" ? "alert" : "status"} className={result.kind === "error" ? "field__error" : "text-muted"} data-testid="confirm-result">
              {result.text}{link.href ? <> <Link href={link.href}>Abrir o prazo</Link></> : null}
            </p>
          ) : null}
          <MetadataOnlyNotice />
          <Card title="Metadados declarados">
            <div style={{ marginBottom: 8 }}><IntimationStatusBadge status={i.status} /></div>
            <dl style={{ display: "grid", gridTemplateColumns: "max-content 1fr", gap: "4px 16px", margin: 0 }}>
              <dt>Arquivo</dt><dd>{i.file.name} · {formatBytes(i.file.sizeBytes)} · {i.file.contentType}</dd>
              <dt>Armazenamento</dt><dd data-testid="storage">{i.file.storage === "not_stored" ? "Não armazenado (somente metadados)" : i.file.storage}</dd>
              <dt>Processamento</dt><dd data-testid="processing">{i.processing.status === "not_available" ? "Indisponível nesta fase (sem OCR/IA)" : i.processing.status}</dd>
              <dt>Recebida em</dt><dd>{formatCivilDate(i.receivedAt)}</dd>
              <dt>Registrada por</dt><dd>{nameOf(i.createdBy)} em {fmtDate(i.createdAt)}</dd>
              <dt>Responsável sugerido</dt><dd data-testid="suggested">{i.suggestedResponsibleId ? nameOf(i.suggestedResponsibleId) : "Nenhum"}</dd>
              <dt>Prazo vinculado</dt>
              <dd data-testid="linked">
                {link.href ? <Link href={link.href}>Abrir o prazo vinculado</Link>
                  : link.state === "protected" ? "Existe um prazo vinculado, mas você não tem permissão para vê-lo."
                    : "Nenhum (a intimação ainda não foi confirmada)."}
              </dd>
            </dl>
          </Card>
          {caps.canEditDraft ? <DraftSection i={i} reload={res.reload} /> : null}
          {caps.canConfirm ? <ConfirmSection i={i} reload={res.reload} onResult={setResult} /> : null}
          {caps.canDiscard ? <DiscardSection i={i} reload={res.reload} /> : null}
          {i.status === "discarded" ? <Notice>Intimação descartada: não pode ser editada, confirmada nem reprocessada.</Notice> : null}
          <HistorySection i={i} />
        </div>
      );
    }}</ResourceState>
  );
}

type DraftForm = Record<"title" | "caseNumber" | "court" | "practiceArea" | "startDate" | "dueDate" | "countingMode" | "duration" | "priority" | "agendaTime", string>;
function toForm(i: Intimation): DraftForm {
  const d = i.draft;
  return { title: d.title ?? "", caseNumber: d.caseNumber ?? "", court: d.court ?? "", practiceArea: d.practiceArea ?? "",
    startDate: d.startDate ?? "", dueDate: d.dueDate ?? "", countingMode: d.countingMode ?? "", duration: d.duration == null ? "" : String(d.duration),
    priority: d.priority ?? "", agendaTime: d.agendaTime ?? "" };
}

function DraftSection({ i, reload }: { i: Intimation; reload: () => void }) {
  const { intimations, org, members, me, nameOf } = useIntimationContext();
  const invalidate = useInvalidateIntimation();
  const [form, setForm] = useState<DraftForm>(() => toForm(i));
  const [suggested, setSuggested] = useState(i.suggestedResponsibleId ?? "");
  const [conflict, setConflict] = useState(false);
  const [ok, setOk] = useState<string | null>(null);
  const m = useMutation();
  const set = (k: keyof DraftForm) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setForm({ ...form, [k]: e.target.value });
  const base = i.scope.kind === "office" ? selectableResponsibles("office", org.membership, members.status === "ready" ? members.data.members : [], me!) : [];
  const options = i.suggestedResponsibleId && !base.some((b) => b.userId === i.suggestedResponsibleId)
    ? [{ userId: i.suggestedResponsibleId, name: nameOf(i.suggestedResponsibleId) }, ...base] : base;

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setOk(null);
    for (const k of ["startDate", "dueDate"] as const) if (form[k] && !isCivilDate(form[k])) { m.setError("Datas no formato AAAA-MM-DD."); return; }
    if (form.duration && !/^\d+$/.test(form.duration)) { m.setError("Duração: número inteiro de dias."); return; }
    const changes = draftChanges(i.draft, form, i.suggestedResponsibleId, i.scope.kind === "office" ? suggested : (i.suggestedResponsibleId ?? ""));
    if (Object.keys(changes).length === 0) { setOk("Nada a salvar."); return; }
    const r = await m.run(() => intimations.updateDraft(i.id, i.version, changes));     // versão LIDA
    if (r.ok) { setConflict(false); setOk("Rascunho salvo."); invalidate(i.id); reload(); announceNotificationsChanged(); return; }
    if (r.code === "version_conflict") setConflict(true);                                // rascunho preservado
  }

  return (
    <Card title="Rascunho (opcional, só para organizar a revisão)">
      <form onSubmit={save} noValidate aria-label="Rascunho da intimação">
        <Input label="Título" value={form.title} onChange={set("title")} />
        <Input label="Número do processo" value={form.caseNumber} onChange={set("caseNumber")} />
        <Input label="Tribunal / vara" value={form.court} onChange={set("court")} />
        <Input label="Área de atuação" value={form.practiceArea} onChange={set("practiceArea")} />
        <Input label="Início" type="date" value={form.startDate} onChange={set("startDate")} />
        <Input label="Vencimento" type="date" value={form.dueDate} onChange={set("dueDate")} />
        <Input label="Horário (opcional)" type="time" value={form.agendaTime} onChange={set("agendaTime")} />
        <Select label="Forma de contagem (referência)" value={form.countingMode} onChange={set("countingMode")}>
          <option value="">—</option><option value="business">Dias úteis</option><option value="calendar">Dias corridos</option>
        </Select>
        <Input label="Duração em dias (referência)" inputMode="numeric" value={form.duration} onChange={set("duration")} />
        <Select label="Prioridade" value={form.priority} onChange={set("priority")}>
          <option value="">—</option><option value="normal">Normal</option><option value="high">Alta</option>
        </Select>
        {i.scope.kind === "office" ? (
          <Select label="Responsável sugerido" value={suggested} onChange={(e) => setSuggested(e.target.value)}>
            <option value="">Nenhum</option>
            {options.map((o) => <option key={o.userId} value={o.userId}>{o.name}</option>)}
          </Select>
        ) : null}
        <p className="text-muted" style={{ fontSize: "var(--fs-sm)" }}>Campos apagados são limpos no servidor; campos não alterados são mantidos.</p>
        {m.error ? <Notice kind="error">{m.error}</Notice> : null}
        {conflict ? (
          <div role="alert" className="field__error">
            <p>Seu rascunho foi mantido. Carregue a versão atual, revise e salve de novo.</p>
            <Button variant="secondary" size="sm" onClick={() => { invalidate(i.id); reload(); }}>Carregar versão atual (v{i.version} carregada)</Button>
          </div>
        ) : null}
        {ok ? <Notice kind="ok">{ok}</Notice> : null}
        <Button type="submit" variant="secondary" disabled={m.busy}>{m.busy ? "Salvando…" : "Salvar rascunho"}</Button>
      </form>
    </Card>
  );
}

function initialConfirm(i: Intimation, fallbackResponsible: string): DeadlineDraft {
  const d = i.draft;
  return { title: d.title ?? "", caseNumber: d.caseNumber ?? "", court: d.court ?? "", practiceArea: d.practiceArea ?? "",
    responsibleId: fallbackResponsible, priority: d.priority ?? "normal", startDate: d.startDate ?? "", dueDate: d.dueDate ?? "",
    countingMode: d.countingMode ?? "business", duration: d.duration == null ? "" : String(d.duration), agendaTime: d.agendaTime ?? "", reviewed: true };
}

function ConfirmSection({ i, reload, onResult }: {
  i: Intimation; reload: () => void; onResult: (r: { kind: "ok" | "info" | "error"; text: string }) => void;
}) {
  const { intimations, org, members, me } = useIntimationContext();
  const invalidate = useInvalidateIntimation();
  const responsibles = selectableResponsibles(i.scope.kind, org.membership, members.status === "ready" ? members.data.members : [], me!);
  const fallback = responsibles.some((r) => r.userId === i.suggestedResponsibleId) ? i.suggestedResponsibleId! : me!.id;
  const [draft, setDraft] = useState<DeadlineDraft>(() => initialConfirm(i, fallback));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [reviewed, setReviewed] = useState(false);
  const [ask, setAsk] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [unknown, setUnknown] = useState(false);
  const m = useMutation();

  function prepare(e: React.FormEvent) {
    e.preventDefault();
    const errs = validateDraft(draft);
    if (!reviewed) errs.reviewed = "Confirme que revisou manualmente todos os dados.";
    setErrors(errs);
    if (!Object.keys(errs).length) setAsk(true);
  }

  async function send() {
    setAsk(false);
    setUnknown(false);
    const { reviewed: _ignored, ...data } = draftToInput(draft);          // todos os campos finais explícitos
    void _ignored;
    const r = await m.run(() => intimations.confirm(i.id, i.version, data));
    if (r.ok) {
      // Só o texto: nenhum id da resposta é guardado (a recarga traz a projeção atual autorizada).
      onResult(r.value.created
        ? { kind: "ok", text: "Revisão confirmada: prazo criado." }
        : { kind: "info", text: "Esta intimação já havia sido confirmada; nenhum prazo novo foi criado." });
      invalidate(i.id); reload(); announceNotificationsChanged();
      return;
    }
    if (r.code === "already_reviewed") { onResult({ kind: "info", text: "Esta intimação já foi revisada. Você não tem permissão para ver o prazo vinculado." }); invalidate(i.id); reload(); return; }
    if (r.code === "version_conflict") setConflict(true);
    if (r.code === "invalid_state") { invalidate(i.id); reload(); }
    if (r.unknownOutcome) setUnknown(true);
  }

  return (
    <Card title="Revisão humana e confirmação">
      <p>Confira e complete <strong>todos</strong> os dados do prazo. Nada é preenchido automaticamente pelo servidor;
        o vencimento é o informado por você e não é cálculo processual oficial.</p>
      <form onSubmit={prepare} noValidate aria-label="Confirmar intimação">
        <DeadlineFields draft={draft} onChange={setDraft} errors={errors} responsibles={responsibles} lockResponsible={responsibles.length <= 1} hideReviewed />
        <label style={{ display: "block", margin: "8px 0" }}>
          <input type="checkbox" checked={reviewed} onChange={(e) => setReviewed(e.target.checked)} />{" "}
          Revisei manualmente todos os dados acima com base na intimação
        </label>
        {errors.reviewed ? <p className="field__error" role="alert">{errors.reviewed}</p> : null}
        {m.error ? <Notice kind="error">{m.error}</Notice> : null}
        {conflict ? (
          <div role="alert" className="field__error">
            <p>A intimação mudou depois que você abriu a tela. Seus dados foram mantidos: carregue a versão atual e confirme de novo.</p>
            <Button variant="secondary" size="sm" onClick={() => { setConflict(false); invalidate(i.id); reload(); }}>Carregar versão atual</Button>
          </div>
        ) : null}
        {unknown ? <Button variant="secondary" size="sm" onClick={() => { setUnknown(false); m.clear(); invalidate(i.id); reload(); }}>Conferir situação da intimação</Button> : null}
        <Button type="submit" disabled={m.busy}>{m.busy ? "Confirmando…" : "Confirmar e criar prazo"}</Button>
      </form>
      <ConfirmDialog open={ask} title="Confirmar intimação e criar o prazo?" confirmLabel="Confirmar e criar prazo" cancelLabel="Voltar"
        message="Um prazo será criado com os dados revisados. A intimação ficará como revisada e não poderá voltar a ser editada."
        onCancel={() => setAsk(false)} onConfirm={() => void send()} />
    </Card>
  );
}

function DiscardSection({ i, reload }: { i: Intimation; reload: () => void }) {
  const { intimations } = useIntimationContext();
  const invalidate = useInvalidateIntimation();
  const m = useMutation();
  const [ask, setAsk] = useState(false);
  return (
    <Card title="Descartar">
      <p className="text-muted">Descartar encerra a intimação sem criar prazo. Ela fica oculta da lista e é removida após o período de retenção.</p>
      {m.error ? <Notice kind="error">{m.error}</Notice> : null}
      <Button variant="danger" disabled={m.busy} onClick={() => setAsk(true)}>Descartar intimação</Button>
      <ConfirmDialog open={ask} title="Descartar intimação?" danger confirmLabel="Descartar" cancelLabel="Voltar"
        message="A intimação não poderá ser editada, confirmada nem reprocessada." onCancel={() => setAsk(false)}
        onConfirm={async () => { setAsk(false); const r = await m.run(() => intimations.discard(i.id, i.version)); if (r.ok || r.code === "invalid_state") { invalidate(i.id); reload(); } }} />
    </Card>
  );
}

function HistorySection({ i }: { i: Intimation }) {
  const { intimations, nameOf } = useIntimationContext();
  const [page, setPage] = useState(1);
  const res = useResource<IntimationEventPage>(`intimation:${i.id}:history:p${page}:v${i.version}`, () => intimations.history(i.id, page, 20));
  return (
    <Card title="Histórico">
      <ResourceState res={res}>{(data) => (
        <>
          <ul aria-label="Histórico da intimação" style={{ listStyle: "none", padding: 0 }}>
            {data.items.map((e) => (
              <li key={e.id} style={{ padding: "4px 0" }}>
                <span className="text-muted">{fmtDate(e.at)}</span> · <strong>{e.actorId === "system" ? "Sistema" : nameOf(e.actorId)}</strong>: {describeIntimationEvent(e, (u) => nameOf(u))}
              </li>
            ))}
          </ul>
          <Pagination page={data.page} pageCount={Math.max(1, Math.ceil(data.total / data.perPage))} onPage={setPage} />
        </>
      )}</ResourceState>
    </Card>
  );
}
