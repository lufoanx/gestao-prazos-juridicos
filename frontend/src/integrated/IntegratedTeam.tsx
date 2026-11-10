"use client";
// Equipe integrada (6.2): projeções pública/administrativa, edição com delegação limitada,
// promoção, remoção e saída com sucessor/reatribuição. Sem contagens inventadas: se o servidor
// exigir reatribuição, explicamos a necessidade e pedimos o destino — sem afirmar quantidades.
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Badge, Button, ConfirmDialog, EmptyState, Input, Modal, Select } from "@/components/ui";
import { ALL_PERMS, canEditTarget, capabilities, grantablePermissions } from "@/lib/integration/org-controller.mjs";
import type { MemberAdmin, MemberPublic, MembersResponse } from "@/lib/integration/dto.d.mts";
import { useAuth } from "./AuthProvider";
import { useOrg } from "./OrgProvider";
import { useResource } from "./useResource";
import { Card, Notice, PERMISSION_LABELS, PageHead, ResourceState, useMutation } from "./ui";

type Member = MemberAdmin | MemberPublic;

export function IntegratedTeam() {
  const { state } = useOrg();
  if (state.status !== "ready") return <p aria-busy="true">Carregando…</p>;
  if (!state.office) return <><PageHead title="Equipe" /><Notice>Você não pertence a um escritório no momento.</Notice></>;
  if (state.scope !== "office") return <><PageHead title="Equipe" /><Notice>Selecione o ambiente do escritório no topo para ver a equipe.</Notice></>;
  return <TeamView officeId={state.office.id} />;
}

function TeamView({ officeId }: { officeId: string }) {
  const { state: auth } = useAuth();
  const { state, org, controller } = useOrg();
  const router = useRouter();
  const me = auth.user!.id;
  const res = useResource("members", () => org.members(officeId));
  const caps = capabilities(state.membership);
  const [editing, setEditing] = useState<MemberAdmin | null>(null);
  const [promoting, setPromoting] = useState<Member | null>(null);
  const [removing, setRemoving] = useState<Member | null>(null);
  const [leaving, setLeaving] = useState(false);
  const [ok, setOk] = useState<string | null>(null);
  const promote = useMutation();

  const afterChange = async (msg: string) => { setOk(msg); res.reload(); await controller.changed().catch(() => {}); };

  return (
    <div>
      <PageHead title="Equipe">
        <Button variant="secondary" onClick={() => setLeaving(true)}>Sair do escritório</Button>
      </PageHead>
      {ok ? <Notice kind="ok">{ok}</Notice> : null}
      {promote.error ? <Notice kind="error">{promote.error}</Notice> : null}
      <ResourceState res={res}>{(data: MembersResponse) => {
        // Campos administrativos SÓ com projeção administrativa E permissão atual de gestão.
        const adminView = data.projection === "admin" && caps.canManageTeam;
        const isAdminView = (m: Member): m is MemberAdmin => adminView && "permissions" in m;
        return (
        <Card title={adminView ? "Membros (visão de gestão)" : "Membros"}>
          {data.members.length === 0 ? <EmptyState title="Nenhum membro." /> : (
            <ul aria-label="Membros" style={{ listStyle: "none", padding: 0 }}>
              {data.members.map((m) => {
                const editable = isAdminView(m) && canEditTarget(state.membership, me, m);
                const targetIsAdmin = isAdminView(m) && m.permissions.includes("team.manage") && m.permissions.includes("office.manage");
                return (
                  <li key={m.userId} data-testid={`member-${m.userId}`} style={{ padding: "8px 0", borderBottom: "1px solid var(--border, #eee)" }}>
                    <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                      <strong>{m.name}</strong>{m.userId === me ? <Badge tone="info">Você</Badge> : null}
                      <span className="text-muted">{m.roleLabel}</span>
                      {targetIsAdmin ? <Badge tone="teal">Administrador</Badge> : null}
                    </div>
                    {m.practiceAreas.length ? <div className="text-muted">Áreas: {m.practiceAreas.join(", ")}</div> : null}
                    {isAdminView(m) ? (
                      <div className="text-muted" style={{ fontSize: "var(--fs-sm)" }}>
                        {m.email} · visibilidade: {m.visibility === "all" ? "todos os prazos" : "só os atribuídos"} ·
                        permissões: {m.permissions.map((p) => PERMISSION_LABELS[p] ?? p).join(", ")}
                      </div>
                    ) : null}
                    <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
                      {editable ? <Button size="sm" variant="secondary" onClick={() => setEditing(m as MemberAdmin)}>Editar</Button> : null}
                      {caps.isAdmin && isAdminView(m) && !targetIsAdmin && m.userId !== me
                        ? <Button size="sm" variant="secondary" disabled={promote.busy} onClick={() => setPromoting(m)}>Promover a administrador</Button> : null}
                      {editable ? <Button size="sm" variant="danger" onClick={() => setRemoving(m)}>Remover</Button> : null}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
          {!adminView ? <p className="text-muted">E-mails e permissões dos membros são visíveis só para quem gere a equipe.</p> : null}
        </Card>
        );
      }}</ResourceState>

      {editing ? <EditMember officeId={officeId} target={editing} onClose={() => setEditing(null)}
        onSaved={async () => { setEditing(null); await afterChange("Membro atualizado."); }} /> : null}

      <ConfirmDialog open={!!promoting} title="Promover a administrador?" confirmLabel="Promover"
        message="A pessoa passará a gerir a equipe e o escritório." onCancel={() => setPromoting(null)}
        onConfirm={async () => { const t = promoting; setPromoting(null); if (t && (await promote.run(() => org.promote(officeId, t.userId))).ok) await afterChange("Membro promovido."); }} />

      {removing ? (
        <ExitFlow mode="remove" officeId={officeId} target={removing} members={res.status === "ready" ? res.data.members : []}
          me={me} onClose={() => setRemoving(null)} onDone={async () => { setRemoving(null); await afterChange("Membro removido."); }} />
      ) : null}
      {leaving ? (
        <ExitFlow mode="leave" officeId={officeId} target={null} members={res.status === "ready" ? res.data.members : []}
          me={me} onClose={() => setLeaving(false)}
          onDone={async () => { setLeaving(false); await controller.changed().catch(() => {}); router.push("/app"); }} />
      ) : null}
    </div>
  );
}

function EditMember({ officeId, target, onClose, onSaved }: { officeId: string; target: MemberAdmin; onClose: () => void; onSaved: () => void }) {
  const { state, org } = useOrg();
  const grantable = new Set(grantablePermissions(state.membership));
  const caps = capabilities(state.membership);
  const [roleLabel, setRoleLabel] = useState(target.roleLabel);
  const [areas, setAreas] = useState(target.practiceAreas.join(", "));
  const [visibility, setVisibility] = useState(target.visibility);
  const [perms, setPerms] = useState<string[]>(target.permissions);
  const m = useMutation();

  async function save() {
    const body: Record<string, unknown> = {};
    const areaList = areas.split(",").map((a) => a.trim()).filter(Boolean);
    if (roleLabel.trim() !== target.roleLabel) body.roleLabel = roleLabel.trim();
    if (areaList.join("|") !== target.practiceAreas.join("|")) body.practiceAreas = areaList;
    if (visibility !== target.visibility) body.visibility = visibility;
    const ordered = ALL_PERMS.filter((p) => perms.includes(p));
    if (ordered.join("|") !== ALL_PERMS.filter((p) => target.permissions.includes(p)).join("|")) body.permissions = ordered;
    if (Object.keys(body).length === 0) { onClose(); return; }
    if (body.permissions && (body.permissions as string[]).length === 0) { m.setError("Mantenha ao menos uma permissão."); return; }
    const r = await m.run(() => org.updateMember(officeId, target.userId, body));
    if (r.ok) onSaved();
  }

  return (
    <Modal open title={`Editar ${target.name}`} onClose={onClose} footer={
      <>
        <Button variant="secondary" onClick={onClose}>Cancelar</Button>
        <Button onClick={save} disabled={m.busy}>{m.busy ? "Salvando…" : "Salvar"}</Button>
      </>
    }>
      <Input label="Cargo (rótulo visual)" value={roleLabel} onChange={(e) => setRoleLabel(e.target.value)} hint="O cargo não concede permissões." />
      <Input label="Áreas de atuação (separadas por vírgula)" value={areas} onChange={(e) => setAreas(e.target.value)} />
      <Select label="Visibilidade de prazos" value={visibility} onChange={(e) => setVisibility(e.target.value as "all" | "assigned")}>
        <option value="assigned">Só os atribuídos a ela</option>
        <option value="all" disabled={!caps.visibilityAll && !caps.isAdmin}>Todos os prazos do escritório</option>
      </Select>
      <fieldset style={{ border: 0, padding: 0 }}>
        <legend>Permissões</legend>
        {ALL_PERMS.map((p) => (
          <label key={p} style={{ display: "block" }}>
            <input type="checkbox" checked={perms.includes(p)} disabled={!grantable.has(p)}
              onChange={(e) => setPerms(e.target.checked ? [...perms, p] : perms.filter((x) => x !== p))} />{" "}
            {PERMISSION_LABELS[p]}{!grantable.has(p) ? <span className="text-muted"> (você não pode conceder)</span> : null}
          </label>
        ))}
      </fieldset>
      {m.error ? <Notice kind="error">{m.error}</Notice> : null}
    </Modal>
  );
}

/** Remoção/saída: confirmação explícita; se o servidor exigir sucessor/reatribuição, pede o destino. */
function ExitFlow({ mode, officeId, target, members, me, onClose, onDone }: {
  mode: "remove" | "leave"; officeId: string; target: Member | null; members: Member[]; me: string;
  onClose: () => void; onDone: () => void;
}) {
  const { org } = useOrg();
  const m = useMutation();
  const [needs, setNeeds] = useState<{ successor: boolean; reassign: boolean }>({ successor: false, reassign: false });
  const [successor, setSuccessor] = useState("");
  const [reassignTo, setReassignTo] = useState("");
  const leavingId = mode === "remove" ? target!.userId : me;
  const others = members.filter((x) => x.userId !== leavingId);

  async function submit() {
    if (needs.successor && !successor) { m.setError("Escolha quem assumirá a administração."); return; }
    if (needs.reassign && !reassignTo) { m.setError("Escolha quem receberá as responsabilidades."); return; }
    const r = await m.run(() => mode === "remove"
      ? org.removeMember(officeId, leavingId, reassignTo || undefined)
      : org.leave(officeId, { successorUserId: successor || undefined, reassignTo: reassignTo || undefined }));
    if (r.ok) { onDone(); return; }
    // Sem repetir automaticamente: mostra o que falta e espera nova confirmação do usuário.
    if (r.code === "successor_required") setNeeds((n) => ({ ...n, successor: true }));
    if (r.code === "reassign_required") setNeeds((n) => ({ ...n, reassign: true }));
  }

  return (
    <Modal open title={mode === "remove" ? `Remover ${target!.name}?` : "Sair do escritório?"} onClose={onClose} footer={
      <>
        <Button variant="secondary" onClick={onClose}>Cancelar</Button>
        <Button variant="danger" onClick={submit} disabled={m.busy}>{m.busy ? "Enviando…" : mode === "remove" ? "Remover" : "Sair"}</Button>
      </>
    }>
      <p>{mode === "remove"
        ? "A pessoa perde o acesso ao escritório imediatamente. Os dados pessoais dela não são afetados."
        : "Você perderá o acesso aos dados do escritório. Seu ambiente pessoal continua disponível."}</p>
      {needs.successor ? (
        <Select label="Novo administrador" value={successor} onChange={(e) => setSuccessor(e.target.value)} required>
          <option value="">Escolha um membro</option>
          {others.map((x) => <option key={x.userId} value={x.userId}>{x.name}</option>)}
        </Select>
      ) : null}
      {needs.reassign ? (
        <>
          <p className="text-muted">O servidor informou que há responsabilidades em aberto que precisam de um novo responsável.</p>
          <Select label="Reatribuir para" value={reassignTo} onChange={(e) => setReassignTo(e.target.value)} required>
            <option value="">Escolha um membro</option>
            {others.map((x) => <option key={x.userId} value={x.userId}>{x.name}</option>)}
          </Select>
        </>
      ) : null}
      {m.error ? <Notice kind="error">{m.error}</Notice> : null}
    </Modal>
  );
}
