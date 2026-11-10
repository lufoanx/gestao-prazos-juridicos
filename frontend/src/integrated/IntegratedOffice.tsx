"use client";
// Escritório integrado (6.2): dados, código de ingresso, convites e solicitações do escritório.
// Controles aparecem conforme as permissões ATUAIS do vínculo; o servidor decide de verdade.
import { useState } from "react";
import { Badge, Button, ConfirmDialog, EmptyState, Input } from "@/components/ui";
import { capabilities } from "@/lib/integration/org-controller.mjs";
import { buildInviteLink } from "@/lib/integration/invite-token.mjs";
import type { InvitationAdmin, OfficeJoinRequest } from "@/lib/integration/dto.d.mts";
import { useOrg } from "./OrgProvider";
import { useResource } from "./useResource";
import { Card, Notice, PageHead, ResourceState, fmtDate, useMutation } from "./ui";

const INVITE_TONE = { valid: "success", expired: "warning", revoked: "neutral", used: "info" } as const;
const INVITE_LABEL = { valid: "Válido", expired: "Expirado", revoked: "Revogado", used: "Utilizado" } as const;
const REQUEST_LABEL = { pending: "Pendente", approved: "Aprovada", rejected: "Rejeitada", cancelled: "Cancelada" } as const;

export function IntegratedOffice() {
  const { state } = useOrg();
  if (state.status !== "ready") return <p aria-busy="true">Carregando…</p>;
  if (!state.office || !state.membership) {
    return <><PageHead title="Escritório" /><Notice>Você não pertence a um escritório no momento.</Notice></>;
  }
  if (state.scope !== "office") {
    return <><PageHead title="Escritório" /><Notice>Você está no ambiente pessoal. Selecione o ambiente do escritório no topo para ver esta área.</Notice></>;
  }
  return <OfficeView officeId={state.office.id} />;
}

function OfficeView({ officeId }: { officeId: string }) {
  const { state, org, controller } = useOrg();
  const caps = capabilities(state.membership);
  const [name, setName] = useState(state.office?.name ?? "");
  const [ok, setOk] = useState<string | null>(null);
  const rename = useMutation();

  async function saveName(e: React.FormEvent) {
    e.preventDefault();
    setOk(null);
    if (name.trim().length < 2) { rename.setError("Informe o nome do escritório (mínimo 2 caracteres)."); return; }
    const r = await rename.run(() => org.renameOffice(officeId, name.trim()));
    if (r.ok) { setOk("Nome atualizado."); await controller.changed().catch(() => {}); }
  }

  return (
    <div>
      <PageHead title={state.office?.name ?? "Escritório"} />
      <Card title="Dados do escritório">
        <p>Seu cargo exibido: <strong>{state.membership?.roleLabel}</strong> <span className="text-muted">(rótulo visual; não define permissões)</span></p>
        {caps.canManageOffice ? (
          <form onSubmit={saveName} noValidate aria-label="Dados do escritório">
            <Input label="Nome do escritório" value={name} onChange={(e) => setName(e.target.value)} required />
            {rename.error ? <Notice kind="error">{rename.error}</Notice> : null}
            {ok ? <Notice kind="ok">{ok}</Notice> : null}
            <Button type="submit" disabled={rename.busy}>{rename.busy ? "Salvando…" : "Salvar nome"}</Button>
          </form>
        ) : <p className="text-muted">Somente quem gere o escritório pode alterar o nome.</p>}
      </Card>
      {caps.canManageTeam ? <JoinCodeCard officeId={officeId} /> : null}
      {caps.canManageTeam ? <InvitationsCard officeId={officeId} canCreate={caps.canGrantEntry} /> : null}
      {caps.canManageTeam ? <RequestsCard officeId={officeId} canApprove={caps.canApproveRequests} canReject={caps.canRejectRequests} /> : null}
      {!caps.canManageTeam ? <Card><p className="text-muted">Convites, código de ingresso e solicitações são geridos por quem tem a permissão “Gerir equipe”.</p></Card> : null}
    </div>
  );
}

function JoinCodeCard({ officeId }: { officeId: string }) {
  const { org } = useOrg();
  const res = useResource("join-code", () => org.joinCode(officeId));
  const m = useMutation();
  const [confirm, setConfirm] = useState(false);
  const [ok, setOk] = useState<string | null>(null);
  return (
    <Card title="Código de ingresso">
      <ResourceState res={res}>{(data) => (
        <>
          <p>Compartilhe este código com quem deve solicitar ingresso: <strong data-testid="join-code" style={{ fontFamily: "monospace", fontSize: "var(--fs-lg)" }}>{data.joinCode}</strong></p>
          <p className="text-muted">Quem usar o código cria uma solicitação; a entrada só acontece após aprovação.</p>
          {m.error ? <Notice kind="error">{m.error}</Notice> : null}
          {ok ? <Notice kind="ok">{ok}</Notice> : null}
          <Button variant="secondary" disabled={m.busy} onClick={() => setConfirm(true)}>Gerar novo código</Button>
        </>
      )}</ResourceState>
      <ConfirmDialog open={confirm} title="Gerar novo código?" danger confirmLabel="Gerar novo código"
        message="O código atual deixará de funcionar imediatamente." onCancel={() => setConfirm(false)}
        onConfirm={async () => { setConfirm(false); setOk(null); const r = await m.run(() => org.rotateJoinCode(officeId)); if (r.ok) { setOk("Novo código gerado."); res.reload(); } }} />
    </Card>
  );
}

function InvitationsCard({ officeId, canCreate }: { officeId: string; canCreate: boolean }) {
  const { org } = useOrg();
  const res = useResource("invitations", () => org.invitations(officeId));
  const create = useMutation();
  const revoke = useMutation();
  const [roleLabel, setRoleLabel] = useState("Membro");
  const [link, setLink] = useState<string | null>(null);       // só em memória, só nesta tela
  const [copied, setCopied] = useState(false);
  const [toRevoke, setToRevoke] = useState<InvitationAdmin | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setLink(null);
    setCopied(false);
    const r = await create.run(() => org.createInvitation(officeId, roleLabel.trim() || undefined));
    if (r.ok) { setLink(buildInviteLink(window.location.origin, r.value.token)); res.reload(); }
  }

  return (
    <Card title="Convites">
      {canCreate ? (
        <form onSubmit={submit} noValidate aria-label="Criar convite">
          <Input label="Cargo exibido para o convidado" value={roleLabel} onChange={(e) => setRoleLabel(e.target.value)} hint="O cargo é só um rótulo; o convidado entra com as permissões padrão de membro." />
          {create.error ? <Notice kind="error">{create.error}</Notice> : null}
          <Button type="submit" disabled={create.busy}>{create.busy ? "Gerando…" : "Gerar link de convite"}</Button>
        </form>
      ) : <p className="text-muted">Para convidar, é preciso ter “Gerir equipe” e todas as permissões padrão de membro.</p>}
      {link ? (
        <div style={{ marginTop: 12 }}>
          <Input label="Link do convite (exibido só agora)" value={link} readOnly onFocus={(e) => e.currentTarget.select()} />
          <Button variant="secondary" size="sm" onClick={async () => { try { await navigator.clipboard.writeText(link); setCopied(true); } catch { setCopied(false); } }}>Copiar link</Button>
          <Notice>{copied ? "Link copiado. " : ""}Nenhum e-mail é enviado: copie o link e envie você mesmo. Ele não será exibido de novo.</Notice>
        </div>
      ) : null}
      <h3 style={{ fontSize: "var(--fs-md)", margin: "16px 0 8px" }}>Convites emitidos</h3>
      <ResourceState res={res}>{(items) => items.length === 0 ? <EmptyState title="Nenhum convite emitido." /> : (
        <ul className="list" aria-label="Convites emitidos" style={{ listStyle: "none", padding: 0 }}>
          {items.map((inv) => (
            <li key={inv.id} style={{ display: "flex", gap: 12, alignItems: "center", padding: "6px 0" }}>
              <span>{inv.roleLabel}</span>
              <Badge tone={INVITE_TONE[inv.state]}>{INVITE_LABEL[inv.state]}</Badge>
              <span className="text-muted">expira {fmtDate(inv.expiresAt)}</span>
              {inv.state === "valid" ? <Button variant="ghost" size="sm" disabled={revoke.busy} onClick={() => setToRevoke(inv)}>Revogar</Button> : null}
            </li>
          ))}
        </ul>
      )}</ResourceState>
      {revoke.error ? <Notice kind="error">{revoke.error}</Notice> : null}
      <ConfirmDialog open={!!toRevoke} title="Revogar convite?" danger confirmLabel="Revogar"
        message="O link deixará de funcionar." onCancel={() => setToRevoke(null)}
        onConfirm={async () => { const inv = toRevoke; setToRevoke(null); if (inv && (await revoke.run(() => org.revokeInvitation(officeId, inv.id))).ok) res.reload(); }} />
    </Card>
  );
}

function RequestsCard({ officeId, canApprove, canReject }: { officeId: string; canApprove: boolean; canReject: boolean }) {
  const { org } = useOrg();
  const res = useResource("join-requests", () => org.officeRequests(officeId));
  const m = useMutation();
  const [pending, setPending] = useState<{ req: OfficeJoinRequest; action: "approve" | "reject" } | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  return (
    <Card title="Solicitações de ingresso">
      <ResourceState res={res}>{(items) => {
        const sorted = [...items].sort((a, b) => (a.status === "pending" ? -1 : 0) - (b.status === "pending" ? -1 : 0));
        return sorted.length === 0 ? <EmptyState title="Nenhuma solicitação." /> : (
          <ul aria-label="Solicitações de ingresso" style={{ listStyle: "none", padding: 0 }}>
            {sorted.map((r) => (
              <li key={r.id} style={{ display: "flex", gap: 12, alignItems: "center", padding: "6px 0" }}>
                <span>{r.requester ? `${r.requester.name} (${r.requester.email})` : "Usuário indisponível"}</span>
                <Badge tone={r.status === "pending" ? "warning" : "neutral"}>{REQUEST_LABEL[r.status]}</Badge>
                {r.status === "pending" && canApprove ? (
                  <Button size="sm" disabled={m.busy} onClick={() => setPending({ req: r, action: "approve" })}>Aprovar</Button>
                ) : null}
                {r.status === "pending" && canReject ? (
                  <Button size="sm" variant="ghost" disabled={m.busy} onClick={() => setPending({ req: r, action: "reject" })}>Rejeitar</Button>
                ) : null}
              </li>
            ))}
          </ul>
        );
      }}</ResourceState>
      {!canApprove ? <p className="text-muted">Aprovar exige “Gerir equipe” e todas as permissões padrão de membro; rejeitar exige apenas “Gerir equipe”.</p> : null}
      {m.error ? <Notice kind="error">{m.error}</Notice> : null}
      {ok ? <Notice kind="ok">{ok}</Notice> : null}
      <ConfirmDialog open={!!pending} danger={pending?.action === "reject"}
        title={pending?.action === "approve" ? "Aprovar solicitação?" : "Rejeitar solicitação?"}
        confirmLabel={pending?.action === "approve" ? "Aprovar" : "Rejeitar"}
        message={pending?.action === "approve" ? "A pessoa entrará no escritório com as permissões padrão de membro. Outras solicitações dela serão canceladas." : "A pessoa poderá solicitar de novo depois."}
        onCancel={() => setPending(null)}
        onConfirm={async () => {
          const p = pending; setPending(null); setOk(null);
          if (!p) return;
          const r = await m.run(() => p.action === "approve" ? org.approveRequest(officeId, p.req.id) : org.rejectRequest(officeId, p.req.id));
          if (r.ok) setOk(p.action === "approve" ? "Solicitação aprovada." : "Solicitação rejeitada.");
          res.reload();
        }} />
    </Card>
  );
}
