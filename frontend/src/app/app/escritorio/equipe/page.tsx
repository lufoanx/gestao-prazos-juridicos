"use client";
import { useMemo, useState } from "react";
import Link from "next/link";
import { Users, ShieldAlert, Copy, Link2, Check, X, UserMinus } from "lucide-react";
import { useScope } from "@/context/ScopeContext";
import { useOrg } from "@/context/OrgContext";
import { useData } from "@/context/DataContext";
import { useSession } from "@/context/SessionContext";
import { useTeamActions } from "@/context/useTeamActions";
import { inviteState as inviteStateOf } from "@/lib/org-ops.mjs";
import { getDemoToday } from "@/lib/clock.mjs";
import { demoUsers } from "@/mocks/data";
import type { Membership, Permission } from "@/types/domain";
import {
  Tabs, Badge, Button, Input, Select, Modal, EmptyState, SearchField, useToast,
} from "@/components/ui";

const PERMS: [Permission, string][] = [
  ["deadline.read", "Ver prazos"],
  ["deadline.create", "Criar / comentar / anexar"],
  ["deadline.edit", "Editar"],
  ["deadline.complete", "Concluir / cancelar"],
  ["deadline.transfer", "Transferir"],
  ["team.manage", "Gerir equipe"],
  ["office.manage", "Administrar escritório"],
];
const INVITE_TONE = { valid: "info", used: "success", revoked: "neutral", expired: "danger", invalid: "danger" } as const;
const INVITE_LABEL = { valid: "Pendente", used: "Aceito", revoked: "Revogado", expired: "Expirado", invalid: "Inválido" } as const;

export default function EquipePage() {
  const { office, scopeKind, membership, user } = useScope();
  const { session } = useSession();
  const org = useOrg();
  const { deadlines } = useData();
  const teamActions = useTeamActions();
  const toast = useToast();
  const today = getDemoToday();
  const [tab, setTab] = useState("membros");
  const [query, setQuery] = useState("");

  const canManageTeam = scopeKind === "office" && !!membership?.permissions.includes("team.manage");

  // Resolve nomes: semeados + solicitantes + sessão atual.
  const nameOf = useMemo(() => {
    const map = new Map<string, string>();
    demoUsers.forEach((u) => map.set(u.id, u.name));
    org.joinRequests.forEach((r) => map.set(r.userId, r.name));
    if (session.user) map.set(session.user.id, session.user.name);
    map.set(user.id, user.name);
    return (id: string) => map.get(id) ?? id;
  }, [org.joinRequests, session.user, user.id, user.name]);

  const members = useMemo(
    () => (office ? org.memberships.filter((m) => m.officeId === office.id) : []),
    [org.memberships, office]
  );
  const filteredMembers = useMemo(() => {
    const q = query.trim().toLowerCase();
    return members.filter((m) => !q || nameOf(m.userId).toLowerCase().includes(q) || m.roleLabel.toLowerCase().includes(q));
  }, [members, query, nameOf]);
  const officeInvites = useMemo(
    () => (office ? org.invites.filter((i) => i.officeId === office.id).sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? "")) : []),
    [org.invites, office]
  );
  const officeRequests = useMemo(
    () => (office ? org.joinRequests.filter((r) => r.officeId === office.id) : []),
    [org.joinRequests, office]
  );

  // edição de membro
  const [editing, setEditing] = useState<Membership | null>(null);
  const [removing, setRemoving] = useState<Membership | null>(null);
  const [reassignTo, setReassignTo] = useState("");
  const [inviteRole, setInviteRole] = useState("Advogado(a)");
  const [lastLink, setLastLink] = useState<string>();

  if (scopeKind !== "office" || !office) {
    return (
      <div>
        <div className="page-head"><div className="page-head__title">
          <h1 style={{ fontSize: "var(--fs-2xl)", fontWeight: 700, color: "var(--text-strong)", margin: 0 }}>Equipe</h1>
        </div></div>
        <div className="card"><div className="card__body">
          <EmptyState icon={<Users size={30} aria-hidden />} title="Ambiente pessoal">Alterne para um escritório para gerenciar a equipe.</EmptyState>
        </div></div>
      </div>
    );
  }
  if (!canManageTeam) {
    return (
      <div>
        <div className="page-head"><div className="page-head__title">
          <h1 style={{ fontSize: "var(--fs-2xl)", fontWeight: 700, color: "var(--text-strong)", margin: 0 }}>Equipe</h1>
          <p className="page-head__subtitle">{office.name}</p>
        </div></div>
        <div className="card"><div className="card__body">
          <EmptyState icon={<ShieldAlert size={30} aria-hidden />} title="Sem permissão">
            Gerir a equipe exige a permissão <Badge tone="neutral">team.manage</Badge>.
          </EmptyState>
        </div></div>
      </div>
    );
  }

  const openFor = (userId: string) => deadlines.filter(
    (d) => d.scope.kind === "office" && d.scope.officeId === office.id && d.responsibleId === userId && d.status === "open"
  );

  function saveMember(patch: { roleLabel: string; areas: string; visibility: "all" | "assigned"; perms: Permission[] }) {
    if (!editing) return;
    org.setMemberProfile(office!.id, editing.userId, {
      roleLabel: patch.roleLabel,
      practiceAreas: patch.areas.split(",").map((a) => a.trim()).filter(Boolean),
      visibility: patch.visibility,
    });
    org.setMemberPermissions(office!.id, editing.userId, patch.perms);
    setEditing(null);
    toast.success("Membro atualizado", "Permissões aplicadas imediatamente.");
  }

  function doRemove() {
    if (!removing) return;
    // Operação coordenada (valida permissão, último admin, prazos em aberto e
    // destinatário ativo; reatribui e remove como unidade). Em falha, nada muda.
    const res = teamActions.removeMember(office!.id, removing.userId, reassignTo || undefined);
    if (!res.ok) {
      const msg = res.reason === "needs-reassign" ? "Reatribua os prazos em aberto antes de remover."
        : res.reason === "invalid-reassign" ? "Escolha um membro ativo do escritório para receber os prazos."
        : res.reason === "last-admin" ? "Não é possível remover o último administrador."
        : "Sem permissão para remover.";
      toast.error("Remoção bloqueada", msg);
      return;
    }
    const hadOpen = openFor(removing.userId).length > 0;
    setRemoving(null); setReassignTo("");
    toast.success("Membro removido", hadOpen ? "Prazos reatribuídos." : undefined);
  }

  function createInvite() {
    const inv = org.createInvite(office!.id, inviteRole);
    if (!inv) { toast.error("Não foi possível gerar convite"); return; }
    const link = `${window.location.origin}/convite/${inv.token}`;
    setLastLink(link);
    navigator.clipboard?.writeText(link).then(() => toast.success("Link copiado", "Cole onde quiser — não há envio de e-mail."), () => toast.info("Convite gerado", "Copie o link abaixo."));
  }

  return (
    <div>
      <div className="page-head">
        <div className="page-head__title">
          <h1 style={{ fontSize: "var(--fs-2xl)", fontWeight: 700, color: "var(--text-strong)", margin: 0 }}>Equipe</h1>
          <p className="page-head__subtitle">{office.name} · {members.length} membro(s)</p>
        </div>
        <div className="page-head__actions">
          <Link className="btn btn--secondary" href="/app/escritorio">Dados do escritório</Link>
        </div>
      </div>

      <Tabs
        items={[
          { id: "membros", label: `Membros (${members.length})` },
          { id: "convites", label: `Convites (${officeInvites.filter((i) => inviteStateOf(i, today) === "valid").length})` },
          { id: "solicitacoes", label: `Solicitações (${officeRequests.filter((r) => r.status === "pending").length})` },
        ]}
        active={tab} onChange={setTab} ariaLabel="Seções da equipe"
      />

      {tab === "membros" && (
        <div style={{ marginTop: 16 }}>
          <div className="toolbar__search" style={{ marginBottom: 12, maxWidth: 340 }}>
            <SearchField label="Buscar membro" value={query} onChange={setQuery} placeholder="Nome ou cargo…" />
          </div>
          {filteredMembers.map((m) => {
            const isAdmin = m.permissions.includes("office.manage");
            const open = openFor(m.userId).length;
            return (
              <div className="attach" key={m.userId} style={{ alignItems: "flex-start" }}>
                <span className="attach__main">
                  <span className="attach__name">
                    {nameOf(m.userId)} {isAdmin ? <Badge tone="teal">Admin</Badge> : null}
                    {m.userId === user.id ? <Badge tone="neutral">você</Badge> : null}
                  </span>
                  <span className="attach__meta">
                    {m.roleLabel} · {m.practiceAreas.join(", ") || "sem áreas"} · visibilidade: {m.visibility === "all" ? "todos os prazos" : "somente atribuídos"} · {open} em aberto
                  </span>
                </span>
                <div style={{ display: "flex", gap: 8 }}>
                  <Button variant="secondary" onClick={() => setEditing(m)}>Editar</Button>
                  <Button variant="danger" onClick={() => { setRemoving(m); setReassignTo(""); }}><UserMinus size={15} aria-hidden /> Remover</Button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {tab === "convites" && (
        <div style={{ marginTop: 16 }}>
          <div className="form-card" style={{ marginBottom: 16, maxWidth: 560 }}>
            <div className="form-note" style={{ marginBottom: 12 }}>
              <Link2 size={16} aria-hidden /><span>Gere um link único de convite. Não há envio de e-mail — copie e compartilhe. O link leva à rota de ingresso.</span>
            </div>
            <div style={{ display: "flex", gap: 10, alignItems: "flex-end", flexWrap: "wrap" }}>
              <div style={{ minWidth: 200 }}>
                <Select label="Cargo sugerido" value={inviteRole} onChange={(e) => setInviteRole(e.target.value)}>
                  <option>Advogado(a)</option><option>Estagiário(a)</option><option>Administrador(a)</option>
                </Select>
              </div>
              <Button variant="primary" onClick={createInvite}>Gerar link de convite</Button>
            </div>
            {lastLink ? (
              <div className="filechip" style={{ marginTop: 12 }}>
                <span className="filechip__icon"><Link2 size={18} aria-hidden /></span>
                <span className="filechip__main"><span className="filechip__name" style={{ userSelect: "all" }}>{lastLink}</span><span className="filechip__meta">link único demonstrativo</span></span>
                <button className="icon-btn" aria-label="Copiar link" onClick={() => { navigator.clipboard?.writeText(lastLink); toast.success("Link copiado"); }}><Copy size={16} aria-hidden /></button>
              </div>
            ) : null}
          </div>
          {officeInvites.length === 0 ? (
            <div className="card"><div className="card__body"><EmptyState icon={<Link2 size={28} aria-hidden />} title="Nenhum convite" /></div></div>
          ) : officeInvites.map((i) => {
            const st = inviteStateOf(i, today);
            return (
              <div className="attach" key={i.id}>
                <span className="attach__main">
                  <span className="attach__name">{i.roleLabel} · <Badge tone={INVITE_TONE[st]}>{INVITE_LABEL[st]}</Badge></span>
                  <span className="attach__meta">expira em {i.expiresAt} · /convite/{i.token.slice(0, 10)}…</span>
                </span>
                <div style={{ display: "flex", gap: 8 }}>
                  {st === "valid" ? (
                    <>
                      <button className="btn btn--secondary btn--sm" onClick={() => { navigator.clipboard?.writeText(`${window.location.origin}/convite/${i.token}`); toast.success("Link copiado"); }}><Copy size={14} aria-hidden /> Copiar</button>
                      <button className="btn btn--ghost btn--sm" onClick={() => { org.revokeInvite(i.id); toast.info("Convite revogado"); }}>Revogar</button>
                    </>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {tab === "solicitacoes" && (
        <div style={{ marginTop: 16 }}>
          {officeRequests.length === 0 ? (
            <div className="card"><div className="card__body"><EmptyState icon={<Users size={28} aria-hidden />} title="Nenhuma solicitação" /></div></div>
          ) : officeRequests.map((r) => (
            <div className="attach" key={r.id}>
              <span className="attach__main">
                <span className="attach__name">{r.name} <Badge tone={r.status === "pending" ? "info" : r.status === "approved" ? "success" : "neutral"}>{r.status === "pending" ? "Pendente" : r.status === "approved" ? "Aprovada" : "Rejeitada"}</Badge></span>
                <span className="attach__meta">{r.email} · {r.createdAt}</span>
              </span>
              {r.status === "pending" ? (
                <div style={{ display: "flex", gap: 8 }}>
                  <Button variant="primary" onClick={() => { const res = org.approveRequest(r.id); toast[res.reason ? "info" : "success"](res.reason === "already-member" ? "Já participa de um escritório" : "Solicitação aprovada"); }}><Check size={15} aria-hidden /> Aprovar</Button>
                  <Button variant="secondary" onClick={() => { org.rejectRequest(r.id); toast.info("Solicitação rejeitada"); }}><X size={15} aria-hidden /> Rejeitar</Button>
                </div>
              ) : null}
            </div>
          ))}
        </div>
      )}

      {/* Modal de edição de membro */}
      {editing ? (
        <MemberEditor
          key={editing.userId}
          member={editing}
          name={nameOf(editing.userId)}
          isSelf={editing.userId === user.id}
          onClose={() => setEditing(null)}
          onSave={saveMember}
        />
      ) : null}

      {/* Remoção com reatribuição obrigatória de prazos em aberto */}
      {removing ? (
        <Modal open title={`Remover ${nameOf(removing.userId)}?`} onClose={() => { setRemoving(null); setReassignTo(""); }}>
          {openFor(removing.userId).length > 0 ? (
            <>
              <p style={{ margin: "0 0 12px", color: "var(--text)" }}>
                Este membro tem <strong>{openFor(removing.userId).length}</strong> prazo(s) em aberto. Reatribua antes de remover.
              </p>
              <Select label="Reatribuir prazos em aberto para" value={reassignTo} onChange={(e) => setReassignTo(e.target.value)}>
                <option value="">Selecione um responsável…</option>
                {members.filter((m) => m.userId !== removing!.userId).map((m) => (
                  <option key={m.userId} value={m.userId}>{nameOf(m.userId)}</option>
                ))}
              </Select>
            </>
          ) : (
            <p style={{ margin: 0, color: "var(--text)" }}>O vínculo desta pessoa com o escritório será encerrado. Os prazos do escritório permanecem no escritório.</p>
          )}
          <div className="form-actions">
            <Button variant="secondary" onClick={() => { setRemoving(null); setReassignTo(""); }}>Cancelar</Button>
            <Button variant="danger" onClick={doRemove}>Remover</Button>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}

function MemberEditor({ member, name, isSelf, onClose, onSave }: {
  member: Membership; name: string; isSelf: boolean;
  onClose: () => void;
  onSave: (patch: { roleLabel: string; areas: string; visibility: "all" | "assigned"; perms: Permission[] }) => void;
}) {
  const [roleLabel, setRoleLabel] = useState(member.roleLabel);
  const [areas, setAreas] = useState(member.practiceAreas.join(", "));
  const [visibility, setVisibility] = useState<"all" | "assigned">(member.visibility);
  const [perms, setPerms] = useState<Permission[]>([...member.permissions]);
  const toggle = (p: Permission) => setPerms((cur) => cur.includes(p) ? cur.filter((x) => x !== p) : [...cur, p]);

  return (
    <Modal open title={`Editar ${name}`} onClose={onClose}>
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <Input label="Cargo" value={roleLabel} onChange={(e) => setRoleLabel(e.target.value)} />
        <Input label="Áreas de atuação (separadas por vírgula)" value={areas} onChange={(e) => setAreas(e.target.value)} />
        <Select label="Visibilidade de prazos" value={visibility} onChange={(e) => setVisibility(e.target.value as "all" | "assigned")}>
          <option value="all">Todos os prazos do escritório</option>
          <option value="assigned">Somente os atribuídos a esta pessoa</option>
        </Select>
        <fieldset style={{ border: "1px solid var(--border)", borderRadius: 8, padding: 12 }}>
          <legend style={{ fontSize: "var(--fs-sm)", color: "var(--muted)", padding: "0 6px" }}>Permissões</legend>
          {PERMS.map(([p, label]) => (
            <label key={p} style={{ display: "flex", alignItems: "center", gap: 8, padding: "3px 0", fontSize: "var(--fs-sm)" }}>
              <input type="checkbox" checked={perms.includes(p)} onChange={() => toggle(p)} />
              {label} <code style={{ color: "var(--muted)", fontSize: "var(--fs-xs)" }}>{p}</code>
            </label>
          ))}
          {isSelf ? (
            <p className="field__hint" style={{ marginTop: 6 }}>Você não pode aumentar as próprias permissões; o último administrador não pode perder a administração.</p>
          ) : null}
        </fieldset>
      </div>
      <div className="form-actions">
        <Button variant="secondary" onClick={onClose}>Cancelar</Button>
        <Button variant="primary" onClick={() => onSave({ roleLabel, areas, visibility, perms })}>Salvar</Button>
      </div>
    </Modal>
  );
}
