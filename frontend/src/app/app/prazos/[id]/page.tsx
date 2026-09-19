"use client";
import { useMemo, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import {
  Pencil, CheckCircle2, RotateCcw, XCircle, Paperclip, Trash2, MessageSquarePlus,
  FileText, History, ShieldAlert, Building2,
} from "lucide-react";
import { useScope } from "@/context/ScopeContext";
import { useData } from "@/context/DataContext";
import { canReadDeadline, canManageDeadline } from "@/lib/access.mjs";
import { OP_PERMISSION } from "@/lib/deadline-guards.mjs";
import { matchesScope } from "@/lib/deadlines-view.mjs";
import { urgencyOf, URGENCY_META } from "@/lib/urgency.mjs";
import { getDemoToday } from "@/lib/clock.mjs";
import { formatCivil, relativeToToday } from "@/lib/dates.mjs";
import { demoUsers } from "@/mocks/data";
import type { Deadline } from "@/types/domain";
import {
  Badge, Button, Breadcrumb, ConfirmDialog, EmptyState, Textarea, useToast,
} from "@/components/ui";

const STATUS_LABEL: Record<Deadline["status"], string> = { open: "Em aberto", completed: "Concluído", cancelled: "Cancelado" };
const STATUS_TONE: Record<Deadline["status"], "info" | "success" | "neutral"> = { open: "info", completed: "success", cancelled: "neutral" };
const ACTION_LABEL: Record<string, string> = {
  created: "Criado", updated: "Editado", completed: "Concluído", cancelled: "Cancelado",
  open: "Reaberto", commented: "Comentário adicionado", attached: "Anexo adicionado", removed_attachment: "Anexo removido",
};

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function PrazoDetalhePage() {
  const params = useParams<{ id: string }>();
  const id = Array.isArray(params.id) ? params.id[0] : params.id;
  const router = useRouter();
  const { scope, scopeKind, user, membership, office } = useScope();
  const { getDeadline, commentsFor, attachmentsFor, historyFor, setStatus, addComment, addAttachment, removeAttachment, transferDeadlineToOffice } = useData();
  const toast = useToast();
  const today = getDemoToday();

  const [comment, setComment] = useState("");
  const [confirmTransfer, setConfirmTransfer] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);

  const nameOf = useMemo(() => {
    const map = new Map<string, string>();
    demoUsers.forEach((u) => map.set(u.id, u.name));
    map.set(user.id, user.name);
    return (uid: string) => map.get(uid) ?? "—";
  }, [user.id, user.name]);

  const deadline = id ? getDeadline(id) : undefined;

  // Isolamento: o prazo precisa pertencer ao ambiente atual e ser legível.
  const inScope = deadline ? matchesScope(deadline, scope) : false;
  const readable = deadline && inScope && canReadDeadline(user.id, membership, deadline);

  if (!deadline || !readable) {
    return (
      <div>
        <Breadcrumb items={[{ label: "Prazos", href: "/app/prazos" }, { label: "Prazo" }]} />
        <div className="card"><div className="card__body">
          <EmptyState icon={<ShieldAlert size={30} aria-hidden />} title="Prazo não encontrado">
            Ele pode não existir, ter sido removido, ou pertencer a outro ambiente. Verifique se você está no ambiente correto (Pessoal/Escritório).
          </EmptyState>
          <div style={{ textAlign: "center", marginTop: 12 }}>
            <Link className="btn btn--secondary" href="/app/prazos">Voltar aos prazos</Link>
          </div>
        </div></div>
      </div>
    );
  }

  const canEdit = canManageDeadline(scopeKind, membership, OP_PERMISSION.edit);
  const canComplete = canManageDeadline(scopeKind, membership, OP_PERMISSION.complete);
  const canCancel = canManageDeadline(scopeKind, membership, OP_PERMISSION.cancel);
  const canComment = canManageDeadline(scopeKind, membership, OP_PERMISSION.comment);

  const comments = commentsFor(deadline.id);
  const attachments = attachmentsFor(deadline.id);
  const history = historyFor(deadline.id);
  const meta = deadline.status === "open" ? URGENCY_META[urgencyOf(deadline.dueDate, today).level] : null;

  function complete() { setStatus(deadline!.id, "completed"); toast.success("Prazo concluído", "Dashboard e calendário atualizados."); }
  function reopen() { setStatus(deadline!.id, "open"); toast.info("Prazo reaberto"); }
  function cancel() { setStatus(deadline!.id, "cancelled"); setConfirmCancel(false); toast.info("Prazo cancelado"); }
  function submitComment(e: React.FormEvent) {
    e.preventDefault();
    if (!comment.trim()) return;
    addComment(deadline!.id, comment);
    setComment("");
    toast.success("Comentário adicionado");
  }
  function addDemoAttachment() {
    const n = attachments.length + 1;
    addAttachment(deadline!.id, { name: `anexo-demonstrativo-${n}.pdf`, size: 90000 + n * 12345 });
    toast.info("Anexo demonstrativo adicionado", "Nenhum arquivo real é enviado.");
  }

  return (
    <div>
      <Breadcrumb items={[{ label: "Prazos", href: "/app/prazos" }, { label: deadline.title }]} />
      <div className="page-head">
        <div className="page-head__title">
          <h1 style={{ fontSize: "var(--fs-2xl)", fontWeight: 700, color: "var(--text-strong)", margin: 0 }}>{deadline.title}</h1>
          <p className="page-head__subtitle">{deadline.caseNumber} · {deadline.court}</p>
        </div>
        <div className="page-head__actions">
          {canEdit && deadline.status === "open" ? (
            <a className="btn btn--secondary" href={`/app/prazos/${deadline.id}/editar`}><Pencil size={16} aria-hidden /> Editar</a>
          ) : null}
          {canComplete && deadline.status === "open" ? (
            <Button variant="primary" onClick={complete}><CheckCircle2 size={16} aria-hidden /> Concluir</Button>
          ) : null}
          {canComplete && deadline.status === "completed" ? (
            <Button variant="secondary" onClick={reopen}><RotateCcw size={16} aria-hidden /> Reabrir</Button>
          ) : null}
          {canCancel && deadline.status === "open" ? (
            <Button variant="danger" onClick={() => setConfirmCancel(true)}><XCircle size={16} aria-hidden /> Cancelar</Button>
          ) : null}
          {deadline.scope.kind === "personal" && deadline.scope.ownerId === user.id
            && office && membership?.permissions.includes("deadline.transfer") ? (
            <Button variant="secondary" onClick={() => setConfirmTransfer(true)}><Building2 size={16} aria-hidden /> Transferir ao escritório</Button>
          ) : null}
        </div>
      </div>

      <div className="detail-grid">
        {/* Coluna principal */}
        <div className="detail-col">
          <section className="card">
            <div className="card__head"><h2 className="card__title">Detalhes do prazo</h2><Badge tone={STATUS_TONE[deadline.status]}>{STATUS_LABEL[deadline.status]}</Badge></div>
            <div className="card__body">
              <div className="detail-due">
                <span className="detail-due__date">{formatCivil(deadline.dueDate)}</span>
                {meta ? <Badge tone={meta.tone} dot>{meta.label} · {relativeToToday(deadline.dueDate, today)}</Badge> : null}
              </div>
              <dl className="kv" style={{ marginTop: 16 }}>
                <dt>Número do processo</dt><dd>{deadline.caseNumber}</dd>
                <dt>Tribunal / Vara</dt><dd>{deadline.court}</dd>
                <dt>Área</dt><dd>{deadline.practiceArea}</dd>
                <dt>Responsável</dt><dd>{nameOf(deadline.responsibleId)}</dd>
                <dt>Prioridade</dt><dd>{deadline.priority === "high" ? "Alta" : "Normal"}</dd>
                <dt>Início</dt><dd>{formatCivil(deadline.startDate)}</dd>
                <dt>Contagem</dt><dd>{deadline.countingMode === "business" ? "Dias úteis" : "Dias corridos"} · {deadline.duration} dia(s) (referência)</dd>
                {deadline.agendaTime ? <><dt>Horário na agenda</dt><dd>{deadline.agendaTime}</dd></> : null}
              </dl>
            </div>
          </section>

          {/* Comentários */}
          <section className="card">
            <div className="card__head"><h2 className="card__title">Comentários</h2><Badge tone="neutral">{comments.length}</Badge></div>
            <div className="card__body">
              {comments.length === 0 ? (
                <EmptyState icon={<MessageSquarePlus size={28} aria-hidden />} title="Sem comentários">Registre observações sobre este prazo.</EmptyState>
              ) : comments.map((c) => (
                <div className="comment" key={c.id}>
                  <div className="comment__meta"><span className="comment__author">{nameOf(c.authorId)}</span> · {formatCivil(c.createdAt)}</div>
                  <div className="comment__text">{c.text}</div>
                </div>
              ))}
              {canComment ? (
                <form className="comment-form" onSubmit={submitComment}>
                  <Textarea label="Novo comentário" value={comment} onChange={(e) => setComment(e.target.value)} rows={3} placeholder="Escreva um comentário…" />
                  <div style={{ display: "flex", justifyContent: "flex-end" }}>
                    <Button type="submit" variant="primary" disabled={!comment.trim()}>Comentar</Button>
                  </div>
                </form>
              ) : null}
            </div>
          </section>
        </div>

        {/* Coluna lateral */}
        <div className="detail-col">
          {/* Anexos */}
          <section className="card">
            <div className="card__head"><h2 className="card__title">Anexos</h2><Badge tone="neutral">{attachments.length}</Badge></div>
            <div className="card__body">
              <div className="form-note" style={{ marginBottom: 12 }}>
                <Paperclip size={16} aria-hidden />
                <span>Anexos são demonstrativos — nenhum arquivo real é enviado ou armazenado.</span>
              </div>
              {attachments.length === 0 ? (
                <EmptyState icon={<FileText size={28} aria-hidden />} title="Sem anexos" />
              ) : attachments.map((a) => (
                <div className="attach" key={a.id}>
                  <span className="attach__icon"><FileText size={18} aria-hidden /></span>
                  <span className="attach__main">
                    <span className="attach__name">{a.name}</span>
                    <span className="attach__meta">{formatSize(a.size)} · demonstrativo</span>
                  </span>
                  {canComment ? (
                    <button className="icon-btn" aria-label={`Remover ${a.name}`} onClick={() => { removeAttachment(a.id); toast.info("Anexo removido"); }}>
                      <Trash2 size={16} aria-hidden />
                    </button>
                  ) : null}
                </div>
              ))}
              {canComment ? (
                <Button variant="secondary" block onClick={addDemoAttachment} style={{ marginTop: 12 }}>
                  <Paperclip size={16} aria-hidden /> Adicionar anexo (demo)
                </Button>
              ) : null}
            </div>
          </section>

          {/* Histórico */}
          <section className="card">
            <div className="card__head"><h2 className="card__title"><History size={16} aria-hidden /> Histórico</h2></div>
            <div className="card__body">
              {history.length === 0 ? (
                <EmptyState icon={<History size={28} aria-hidden />} title="Sem histórico" />
              ) : (
                <ul className="timeline">
                  {history.map((h) => (
                    <li className="timeline__item" key={h.id}>
                      <span className="timeline__dot" aria-hidden />
                      <div className="timeline__action">{ACTION_LABEL[h.action] ?? h.action}</div>
                      <div className="timeline__meta">{nameOf(h.actorId)} · {formatCivil(h.createdAt)}</div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>
        </div>
      </div>

      <ConfirmDialog
        open={confirmTransfer}
        title="Transferir para o escritório?"
        message={`Este prazo pessoal passará a ser COMPARTILHADO com ${office?.name ?? "seu escritório"}. Comentários, anexos e histórico são preservados (mesmo registro). Uma intimação vinculada acompanha o prazo.`}
        confirmLabel="Transferir e compartilhar" cancelLabel="Voltar"
        onCancel={() => setConfirmTransfer(false)}
        onConfirm={() => {
          if (office) transferDeadlineToOffice(deadline.id, office.id);
          setConfirmTransfer(false);
          toast.success("Prazo transferido ao escritório", "Agora é compartilhado com a equipe.");
        }}
      />
      <ConfirmDialog
        open={confirmCancel}
        title="Cancelar este prazo?"
        message="O prazo será marcado como cancelado. Você poderá reabri-lo depois, se necessário."
        confirmLabel="Cancelar prazo" cancelLabel="Voltar" danger
        onCancel={() => setConfirmCancel(false)} onConfirm={cancel}
      />
    </div>
  );
}
