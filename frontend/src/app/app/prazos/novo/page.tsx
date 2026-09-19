"use client";
import { useRouter } from "next/navigation";
import { useScope } from "@/context/ScopeContext";
import { useData } from "@/context/DataContext";
import { useOrg } from "@/context/OrgContext";
import { canManageDeadline } from "@/lib/access.mjs";
import { demoUsers } from "@/mocks/data";
import { Breadcrumb, EmptyState, useToast } from "@/components/ui";
import { DeadlineForm } from "@/components/deadlines/DeadlineForm";
import { ShieldAlert } from "lucide-react";

export default function NovoPrazoPage() {
  const router = useRouter();
  const { scope, scopeKind, user, office, membership } = useScope();
  const { createDeadline } = useData();
  const org = useOrg();
  const toast = useToast();

  const canCreate = canManageDeadline(scopeKind, membership, "deadline.create");

  // Responsáveis = equipe do escritório (roster compartilhado). No pessoal, só você.
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
      <Breadcrumb items={[{ label: "Prazos", href: "/app/prazos" }, { label: "Novo prazo" }]} />
      <div className="page-head">
        <div className="page-head__title">
          <h1 style={{ fontSize: "var(--fs-2xl)", fontWeight: 700, color: "var(--text-strong)", margin: 0 }}>Novo prazo</h1>
          <p className="page-head__subtitle">{scopeKind === "office" ? `Escritório · ${office?.name ?? ""}` : "Ambiente pessoal"}</p>
        </div>
      </div>

      {canCreate ? (
        <DeadlineForm
          candidates={candidates}
          submitLabel="Cadastrar prazo"
          onCancel={() => router.push("/app/prazos")}
          onSubmit={(input) => {
            const id = createDeadline(input);
            if (!id) { toast.error("Não foi possível cadastrar", "Sem permissão neste ambiente."); return; }
            toast.success("Prazo cadastrado", "Dashboard e calendário foram atualizados.");
            router.push(`/app/prazos/${id}`);
          }}
        />
      ) : (
        <div className="card"><div className="card__body">
          <EmptyState icon={<ShieldAlert size={30} aria-hidden />} title="Sem permissão">
            Seu perfil neste escritório não permite cadastrar prazos.
          </EmptyState>
        </div></div>
      )}
    </div>
  );
}
