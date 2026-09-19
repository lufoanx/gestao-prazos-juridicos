"use client";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useScope } from "@/context/ScopeContext";
import { useData } from "@/context/DataContext";
import { useOrg } from "@/context/OrgContext";
import { canReadDeadline, canManageDeadline } from "@/lib/access.mjs";
import { matchesScope } from "@/lib/deadlines-view.mjs";
import { demoUsers } from "@/mocks/data";
import { Breadcrumb, EmptyState, useToast } from "@/components/ui";
import { DeadlineForm } from "@/components/deadlines/DeadlineForm";
import { ShieldAlert } from "lucide-react";

export default function EditarPrazoPage() {
  const params = useParams<{ id: string }>();
  const id = Array.isArray(params.id) ? params.id[0] : params.id;
  const router = useRouter();
  const { scope, scopeKind, user, office, membership } = useScope();
  const { getDeadline, updateDeadline } = useData();
  const org = useOrg();
  const toast = useToast();

  const deadline = id ? getDeadline(id) : undefined;
  const inScope = deadline ? matchesScope(deadline, scope) : false;
  const readable = deadline && inScope && canReadDeadline(user.id, membership, deadline);
  const canEdit = canManageDeadline(scopeKind, membership, "deadline.edit");

  if (!deadline || !readable || !canEdit) {
    return (
      <div>
        <Breadcrumb items={[{ label: "Prazos", href: "/app/prazos" }, { label: "Editar" }]} />
        <div className="card"><div className="card__body">
          <EmptyState icon={<ShieldAlert size={30} aria-hidden />} title="Não é possível editar">
            {deadline && readable && !canEdit
              ? "Seu perfil neste escritório não permite editar prazos."
              : "Prazo não encontrado neste ambiente."}
          </EmptyState>
          <div style={{ textAlign: "center", marginTop: 12 }}>
            <Link className="btn btn--secondary" href="/app/prazos">Voltar aos prazos</Link>
          </div>
        </div></div>
      </div>
    );
  }

  const nameOf = (id: string) => {
    if (id === user.id) return user.name;
    const seeded = demoUsers.find((u) => u.id === id);
    if (seeded) return seeded.name;
    const req = org.joinRequests.find((r) => r.userId === id);
    return req?.name ?? id;
  };
  const candidates = scopeKind === "office" && office
    ? org.memberships.filter((m) => m.officeId === office.id).map((m) => ({ id: m.userId, name: nameOf(m.userId) }))
    : undefined;

  return (
    <div>
      <Breadcrumb items={[{ label: "Prazos", href: "/app/prazos" }, { label: deadline.title, href: `/app/prazos/${deadline.id}` }, { label: "Editar" }]} />
      <div className="page-head">
        <div className="page-head__title">
          <h1 style={{ fontSize: "var(--fs-2xl)", fontWeight: 700, color: "var(--text-strong)", margin: 0 }}>Editar prazo</h1>
          <p className="page-head__subtitle">{deadline.caseNumber} · {deadline.court}</p>
        </div>
      </div>
      <DeadlineForm
        initial={deadline}
        candidates={candidates}
        submitLabel="Salvar alterações"
        onCancel={() => router.push(`/app/prazos/${deadline.id}`)}
        onSubmit={(input) => {
          updateDeadline(deadline.id, {
            title: input.title.trim(), caseNumber: input.caseNumber.trim(), court: input.court.trim(),
            practiceArea: input.practiceArea, responsibleId: input.responsibleId || deadline.responsibleId,
            priority: input.priority, startDate: input.startDate, dueDate: input.dueDate,
            countingMode: input.countingMode, duration: input.duration, agendaTime: input.agendaTime,
          });
          toast.success("Prazo atualizado", "Dashboard e calendário atualizados.");
          router.push(`/app/prazos/${deadline.id}`);
        }}
      />
    </div>
  );
}
