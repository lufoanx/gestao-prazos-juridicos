"use client";
// Solicitação de ingresso por código (6.2) e acompanhamento das próprias solicitações.
import { useState } from "react";
import Link from "next/link";
import { Badge, Button, ConfirmDialog, EmptyState, Input } from "@/components/ui";
import type { OwnJoinRequest } from "@/lib/integration/dto.d.mts";
import { useAuth } from "./AuthProvider";
import { useOrg } from "./OrgProvider";
import { useResource } from "./useResource";
import { PublicFrame } from "./PublicFrame";
import { Card, Notice, ResourceState, fmtDate, useMutation } from "./ui";

const LABEL = { pending: "Pendente", approved: "Aprovada", rejected: "Rejeitada", cancelled: "Cancelada" } as const;

export function IntegratedJoin() {
  const { state: auth } = useAuth();
  const { state: org } = useOrg();
  if (auth.status === "loading") return <PublicFrame title="Solicitar ingresso"><p aria-busy="true">Carregando…</p></PublicFrame>;
  if (auth.status !== "authenticated") {
    return (
      <PublicFrame title="Solicitar ingresso">
        <p>Entre na sua conta para solicitar ingresso em um escritório.</p>
        <p><Link href="/login">Entrar</Link> · <Link href="/cadastro">Criar conta</Link></p>
      </PublicFrame>
    );
  }
  if (org.status !== "ready") return <PublicFrame title="Solicitar ingresso"><p aria-busy="true">Carregando vínculo…</p></PublicFrame>;
  return <JoinView />;
}

function JoinView() {
  const { state: org, org: client, controller } = useOrg();
  const res = useResource("my-join-requests", () => client.myRequests());
  const m = useMutation();
  const cancel = useMutation();
  const [code, setCode] = useState("");
  const [ok, setOk] = useState<string | null>(null);
  const [toCancel, setToCancel] = useState<OwnJoinRequest | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setOk(null);
    const clean = code.replace(/[\s-]/g, "").toUpperCase();
    if (clean.length < 4) { m.setError("Informe o código de ingresso."); return; }
    const r = await m.run(() => client.requestJoin(clean));
    if (r.ok) { setOk(`Solicitação enviada para “${r.value.officeName ?? "escritório"}”. Aguarde a aprovação.`); setCode(""); res.reload(); }
    else if (r.code === "already_in_office") await controller.revalidate();
  }

  return (
    <PublicFrame title="Solicitar ingresso" subtitle="Use o código fornecido por quem administra o escritório.">
      {org.office ? (
        <Notice kind="error">Você já pertence ao escritório “{org.office.name}”. Saia dele antes de solicitar ingresso em outro.</Notice>
      ) : (
        <form onSubmit={submit} noValidate aria-label="Solicitar ingresso">
          <Input label="Código de ingresso" value={code} onChange={(e) => setCode(e.target.value)} autoComplete="off" />
          {m.error ? <Notice kind="error">{m.error}</Notice> : null}
          {ok ? <Notice kind="ok">{ok}</Notice> : null}
          <Button type="submit" disabled={m.busy}>{m.busy ? "Enviando…" : "Solicitar ingresso"}</Button>
        </form>
      )}
      <Card title="Minhas solicitações">
        <ResourceState res={res}>{(items) => items.length === 0 ? <EmptyState title="Nenhuma solicitação." /> : (
          <ul aria-label="Minhas solicitações" style={{ listStyle: "none", padding: 0 }}>
            {items.map((r) => (
              <li key={r.id} style={{ display: "flex", gap: 12, alignItems: "center", padding: "6px 0" }}>
                <span>{r.officeName ?? "Escritório indisponível"}</span>
                <Badge tone={r.status === "pending" ? "warning" : r.status === "approved" ? "success" : "neutral"}>{LABEL[r.status]}</Badge>
                <span className="text-muted">{fmtDate(r.createdAt)}</span>
                {r.status === "pending" ? <Button size="sm" variant="ghost" disabled={cancel.busy} onClick={() => setToCancel(r)}>Cancelar</Button> : null}
              </li>
            ))}
          </ul>
        )}</ResourceState>
        {cancel.error ? <Notice kind="error">{cancel.error}</Notice> : null}
      </Card>
      <ConfirmDialog open={!!toCancel} title="Cancelar solicitação?" danger confirmLabel="Cancelar solicitação" cancelLabel="Voltar"
        message="Você poderá solicitar de novo depois." onCancel={() => setToCancel(null)}
        onConfirm={async () => { const r = toCancel; setToCancel(null); if (r && (await cancel.run(() => client.cancelRequest(r.id))).ok) res.reload(); }} />
    </PublicFrame>
  );
}
