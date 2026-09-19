"use client";
import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Building2, ShieldAlert, Users, Copy, LogOut } from "lucide-react";
import { useScope } from "@/context/ScopeContext";
import { useOrg } from "@/context/OrgContext";
import { Input, Button, EmptyState, Badge, Select, Modal, useToast } from "@/components/ui";

export default function EscritorioPage() {
  const router = useRouter();
  const { office, scopeKind, membership, user } = useScope();
  const { updateOffice, memberships, leaveOffice } = useOrg();
  const toast = useToast();
  const canManageOffice = scopeKind === "office" && !!membership?.permissions.includes("office.manage");
  const canManageTeam = scopeKind === "office" && !!membership?.permissions.includes("team.manage");

  const [name, setName] = useState(office?.name ?? "");
  const [error, setError] = useState<string>();
  const [leaving, setLeaving] = useState(false);
  const [transferTo, setTransferTo] = useState("");

  if (scopeKind !== "office" || !office) {
    return (
      <div>
        <div className="page-head"><div className="page-head__title">
          <h1 style={{ fontSize: "var(--fs-2xl)", fontWeight: 700, color: "var(--text-strong)", margin: 0 }}>Escritório</h1>
        </div></div>
        <div className="card"><div className="card__body">
          <EmptyState icon={<Building2 size={30} aria-hidden />} title="Você está no ambiente pessoal">
            Alterne para um escritório (ou crie um) para ver e editar os dados.
          </EmptyState>
        </div></div>
      </div>
    );
  }

  const officeMembers = office ? memberships.filter((m) => m.officeId === office.id) : [];
  const memberCount = officeMembers.length;
  const admins = officeMembers.filter((m) => m.permissions.includes("office.manage"));
  const isAdmin = !!membership?.permissions.includes("office.manage");
  const isLastAdmin = isAdmin && admins.length <= 1;

  function save(e: React.FormEvent) {
    e.preventDefault();
    if (name.trim().length < 2) { setError("Informe um nome válido."); return; }
    setError(undefined);
    updateOffice(office!.id, { name });
    toast.success("Dados do escritório atualizados");
  }

  const nameOf = (id: string) => (id === user.id ? user.name : id);

  function doLeave() {
    if (!office) return;
    // Saída atômica: o último admin indica o sucessor; a operação transfere e sai juntas.
    const res = leaveOffice(office.id, isLastAdmin ? (transferTo || undefined) : undefined);
    if (!res.ok) {
      toast.error("Não foi possível sair", res.reason === "last-admin" ? "Transfira a administração para um membro antes de sair." : "Você não é membro deste escritório.");
      return;
    }
    setLeaving(false);
    toast.success("Você saiu do escritório", "Seus prazos pessoais continuam privados.");
    router.push("/app/dashboard");
  }

  return (
    <div>
      <div className="page-head">
        <div className="page-head__title">
          <h1 style={{ fontSize: "var(--fs-2xl)", fontWeight: 700, color: "var(--text-strong)", margin: 0 }}>Dados do escritório</h1>
          <p className="page-head__subtitle">{office.name} · {memberCount} membro(s)</p>
        </div>
        {canManageTeam ? (
          <div className="page-head__actions">
            <Link className="btn btn--secondary" href="/app/escritorio/equipe"><Users size={16} aria-hidden /> Equipe</Link>
          </div>
        ) : null}
      </div>

      <div className="form-card" style={{ maxWidth: 560 }}>
        {canManageOffice ? (
          <form className="auth__form" onSubmit={save} noValidate>
            <Input label="Nome do escritório" required value={name} onChange={(e) => setName(e.target.value)} error={error} />
            <div className="form-actions">
              <Button type="submit" variant="primary">Salvar alterações</Button>
            </div>
          </form>
        ) : (
          <>
            <div className="kv">
              <dt>Nome</dt><dd>{office.name}</dd>
              <dt>Seu cargo</dt><dd>{membership?.roleLabel ?? "—"}</dd>
              <dt>Visibilidade</dt><dd>{membership?.visibility === "all" ? "Todos os prazos" : "Somente atribuídos"}</dd>
            </div>
            <div className="form-note" style={{ marginTop: 16 }}>
              <ShieldAlert size={16} aria-hidden />
              <span>Somente administradores (com <Badge tone="neutral">office.manage</Badge>) podem editar os dados do escritório.</span>
            </div>
          </>
        )}
      </div>

      {/* Código do escritório (para solicitações de ingresso) */}
      <div className="form-card" style={{ maxWidth: 560, marginTop: 16 }}>
        <div className="kv">
          <dt>Código do escritório</dt>
          <dd>
            <code style={{ userSelect: "all" }}>{office.id}</code>{" "}
            <button className="icon-btn" aria-label="Copiar código" onClick={() => { navigator.clipboard?.writeText(office.id); toast.success("Código copiado"); }}>
              <Copy size={15} aria-hidden />
            </button>
          </dd>
        </div>
        <div className="form-note" style={{ marginTop: 12 }}>
          <ShieldAlert size={16} aria-hidden />
          <span>Compartilhe este código para receber <strong>solicitações de ingresso</strong> (aprovação manual). Não há diretório público nem envio de e-mail.</span>
        </div>
      </div>

      {/* Sair do escritório */}
      <div className="form-card" style={{ maxWidth: 560, marginTop: 16 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
          <div>
            <div style={{ fontWeight: 700, color: "var(--text-strong)" }}>Sair do escritório</div>
            <div style={{ fontSize: "var(--fs-sm)", color: "var(--muted)" }}>Encerra seu vínculo e remove seu acesso aos dados do escritório. Seus prazos pessoais continuam privados.</div>
          </div>
          <Button variant="danger" onClick={() => { setLeaving(true); setTransferTo(""); }}><LogOut size={16} aria-hidden /> Sair</Button>
        </div>
      </div>

      {leaving ? (
        <Modal open title="Sair do escritório?" onClose={() => setLeaving(false)}>
          {isLastAdmin ? (
            <>
              <p style={{ margin: "0 0 12px", color: "var(--text)" }}>
                Você é o <strong>último administrador</strong>. Transfira a administração para outra pessoa antes de sair.
              </p>
              {officeMembers.filter((m) => m.userId !== user.id).length === 0 ? (
                <div className="form-note"><ShieldAlert size={16} aria-hidden /><span>Não há outro membro para assumir. Convide alguém antes de sair.</span></div>
              ) : (
                <Select label="Transferir administração para" value={transferTo} onChange={(e) => setTransferTo(e.target.value)}>
                  <option value="">Selecione um membro…</option>
                  {officeMembers.filter((m) => m.userId !== user.id).map((m) => (
                    <option key={m.userId} value={m.userId}>{nameOf(m.userId)} · {m.roleLabel}</option>
                  ))}
                </Select>
              )}
            </>
          ) : (
            <p style={{ margin: 0, color: "var(--text)" }}>
              Seu vínculo com <strong>{office.name}</strong> será encerrado e o acesso aos dados do escritório removido imediatamente. Os dados do escritório permanecem nele. Depois você poderá ingressar em outro escritório.
            </p>
          )}
          <div className="form-actions">
            <Button variant="secondary" onClick={() => setLeaving(false)}>Cancelar</Button>
            <Button variant="danger" onClick={doLeave} disabled={isLastAdmin && officeMembers.filter((m) => m.userId !== user.id).length === 0}>Confirmar saída</Button>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}
