"use client";
import { useMemo, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { AlertTriangle, ShieldAlert, CheckCircle2, Loader2 } from "lucide-react";
import { useScope } from "@/context/ScopeContext";
import { useData } from "@/context/DataContext";
import { useOrg } from "@/context/OrgContext";
import { canAccessIntimation } from "@/lib/deadline-guards.mjs";
import { canManageDeadline } from "@/lib/access.mjs";
import { getDemoToday } from "@/lib/clock.mjs";
import { demoUsers } from "@/mocks/data";
import type { Deadline } from "@/types/domain";
import { Breadcrumb, Button, EmptyState, useToast } from "@/components/ui";
import { DeadlineForm, PRACTICE_AREAS } from "@/components/deadlines/DeadlineForm";

export default function RevisaoIntimacaoPage() {
  const params = useParams<{ id: string }>();
  const id = Array.isArray(params.id) ? params.id[0] : params.id;
  const router = useRouter();
  const { scope, scopeKind, user, office, membership } = useScope();
  const { getIntimation, confirmIntimationReview, retryIntimation } = useData();
  const org = useOrg();
  const toast = useToast();
  const [submitting, setSubmitting] = useState(false);

  const ctx = useMemo(() => ({ scope, scopeKind, userId: user.id, membership }), [scope, scopeKind, user.id, membership]);
  const intimation = id ? getIntimation(id) : undefined;
  const access = intimation && canAccessIntimation(intimation, ctx);
  const canCreate = canManageDeadline(scopeKind, membership, "deadline.create");

  if (!intimation || !access) {
    return (
      <div>
        <Breadcrumb items={[{ label: "Intimações", href: "/app/intimacoes" }, { label: "Revisão" }]} />
        <div className="card"><div className="card__body">
          <EmptyState icon={<ShieldAlert size={30} aria-hidden />} title="Intimação não encontrada">
            Ela pode não existir ou pertencer a outro ambiente (Pessoal/Escritório).
          </EmptyState>
          <div style={{ textAlign: "center", marginTop: 12 }}>
            <Link className="btn btn--secondary" href="/app/intimacoes">Voltar às intimações</Link>
          </div>
        </div></div>
      </div>
    );
  }

  // Já revisada → não duplica; mostra o prazo vinculado.
  if (intimation.status === "reviewed") {
    return (
      <div>
        <Breadcrumb items={[{ label: "Intimações", href: "/app/intimacoes" }, { label: "Revisão" }]} />
        <div className="card"><div className="card__body">
          <EmptyState icon={<CheckCircle2 size={30} aria-hidden />} title="Intimação já revisada">
            Esta intimação já gerou um prazo. Não é possível criar outro (proteção contra duplicação).
          </EmptyState>
          <div style={{ textAlign: "center", marginTop: 12 }}>
            {intimation.deadlineId
              ? <Link className="btn btn--primary" href={`/app/prazos/${intimation.deadlineId}`}>Ver prazo criado</Link>
              : <Link className="btn btn--secondary" href="/app/intimacoes">Voltar</Link>}
          </div>
        </div></div>
      </div>
    );
  }

  if (intimation.status === "processing") {
    return (
      <div>
        <Breadcrumb items={[{ label: "Intimações", href: "/app/intimacoes" }, { label: "Revisão" }]} />
        <div className="card"><div className="card__body">
          <div className="proc-state proc-state--processing"><Loader2 size={18} className="spin" aria-hidden /> <span>Ainda processando (simulado)…</span></div>
        </div></div>
      </div>
    );
  }

  if (intimation.status === "failed") {
    return (
      <div>
        <Breadcrumb items={[{ label: "Intimações", href: "/app/intimacoes" }, { label: "Revisão" }]} />
        <div className="card"><div className="card__body">
          <EmptyState icon={<AlertTriangle size={30} aria-hidden />} title="Processamento falhou">
            O processamento simulado falhou. Tente novamente para gerar os dados sugeridos.
          </EmptyState>
          <div style={{ textAlign: "center", marginTop: 12 }}>
            <Button variant="primary" onClick={() => { retryIntimation(intimation.id); toast.info("Reprocessando (simulado)…"); }}>
              Tentar novamente
            </Button>
          </div>
        </div></div>
      </div>
    );
  }

  // awaiting_review → formulário de revisão obrigatória.
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

  const initial = {
    title: intimation.suggestedTitle ?? "",
    caseNumber: intimation.suggestedCaseNumber ?? "",
    court: intimation.suggestedCourt ?? "",
    practiceArea: intimation.suggestedArea && PRACTICE_AREAS.includes(intimation.suggestedArea) ? intimation.suggestedArea : PRACTICE_AREAS[0],
    responsibleId: intimation.suggestedResponsibleId ?? user.id,
    priority: "normal",
    startDate: getDemoToday(),
    dueDate: intimation.suggestedDueDate ?? "",
    countingMode: "business",
    duration: 0,
  } as Deadline;

  return (
    <div>
      <Breadcrumb items={[{ label: "Intimações", href: "/app/intimacoes" }, { label: intimation.fileName }, { label: "Revisão obrigatória" }]} />
      <div className="page-head">
        <div className="page-head__title">
          <h1 style={{ fontSize: "var(--fs-2xl)", fontWeight: 700, color: "var(--text-strong)", margin: 0 }}>Revisão obrigatória</h1>
          <p className="page-head__subtitle">{intimation.fileName} · {scopeKind === "office" ? "Escritório" : "Ambiente pessoal"}</p>
        </div>
      </div>

      <div className="review-banner">
        <AlertTriangle size={18} aria-hidden />
        <span>Os dados abaixo foram <strong>sugeridos por processamento simulado</strong> e <strong>não derivam do PDF</strong>. Confira e corrija processo, tribunal, título, área, responsável e datas antes de confirmar. Nenhum prazo é criado até a confirmação.</span>
      </div>

      {canCreate ? (
        <DeadlineForm
          initial={initial}
          candidates={candidates}
          submitLabel={submitting ? "Confirmando…" : "Confirmar e criar prazo"}
          onCancel={() => router.push("/app/intimacoes")}
          onSubmit={(input) => {
            if (submitting) return;
            setSubmitting(true);
            const deadlineId = confirmIntimationReview(intimation.id, input);
            if (!deadlineId) { setSubmitting(false); toast.error("Não foi possível confirmar", "Sem permissão ou já revisada."); return; }
            toast.success("Prazo criado a partir da intimação", "Dashboard, lista e calendário atualizados.");
            router.push(`/app/prazos/${deadlineId}`);
          }}
        />
      ) : (
        <div className="card"><div className="card__body">
          <EmptyState icon={<ShieldAlert size={30} aria-hidden />} title="Sem permissão">
            Seu perfil neste ambiente não permite confirmar revisões.
          </EmptyState>
        </div></div>
      )}
    </div>
  );
}
