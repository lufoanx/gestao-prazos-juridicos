"use client";
import { useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { Building2, ShieldCheck, ShieldAlert, Info, Clock3 } from "lucide-react";
import { AuthShell } from "@/components/public/AuthShell";
import { Button } from "@/components/ui";
import { useSession } from "@/context/SessionContext";
import { useOrg } from "@/context/OrgContext";
import { inviteState as inviteStateOf } from "@/lib/org-ops.mjs";
import { getDemoToday } from "@/lib/clock.mjs";
import { demoOffice, demoUsers } from "@/mocks/data";

type LinkState = "valid" | "expired" | "revoked" | "used" | "invalid";

// Convite DEMONSTRATIVO. Tokens de teste para exercitar cada estado:
// "demo"/"valido" = válido · "expirado" · "revogado" · "usado" · outro = inválido.
// O convite válido aponta para o escritório semeado (para demonstrar o ingresso
// em um escritório que já tem prazos).
function resolveLink(token: string): LinkState {
  if (token === "demo" || token === "valido") return "valid";
  if (token === "expirado") return "expired";
  if (token === "revogado") return "revoked";
  if (token === "usado") return "used";
  return "invalid";
}

const BAD: Record<Exclude<LinkState, "valid">, { title: string; msg: string; tone: "warn" | "err" }> = {
  expired: { title: "Convite expirado", msg: "Este link de convite expirou. Peça ao administrador um novo convite.", tone: "warn" },
  revoked: { title: "Convite revogado", msg: "Este convite foi revogado pelo escritório e não pode mais ser usado.", tone: "warn" },
  used: { title: "Convite já utilizado", msg: "Este convite já foi aceito. Peça um novo link se ainda precisar ingressar.", tone: "warn" },
  invalid: { title: "Convite inválido", msg: "Este link de convite é inválido ou está incompleto.", tone: "err" },
};

export default function ConvitePage() {
  const params = useParams<{ token: string }>();
  const router = useRouter();
  const { session, canAccept, acceptInvite } = useSession();
  const org = useOrg();

  const token = Array.isArray(params.token) ? params.token[0] : (params.token ?? "");
  const today = getDemoToday();

  // Convite REAL (gerado pela equipe) tem prioridade; senão, tokens demo semeados.
  const realInvite = org.invites.find((i) => i.token === token);
  const isReal = !!realInvite;
  const state: LinkState = isReal ? (inviteStateOf(realInvite, today) as LinkState) : resolveLink(token);

  // Escritório do convite: real (pelo officeId) ou o semeado (tokens demo).
  const office = isReal ? (org.offices.find((o) => o.id === realInvite!.officeId) ?? demoOffice) : demoOffice;
  const inviter = demoUsers[0]?.name ?? "Administrador";
  const [loading, setLoading] = useState(false);

  function accept() {
    setLoading(true);
    if (isReal) {
      const actor = session.user;
      if (!actor) { setLoading(false); router.push("/login"); return; }
      const res = org.acceptInvite(token, actor);
      if (!res.officeId) { setLoading(false); return; }
      setTimeout(() => router.push("/app/dashboard"), 500);
      return;
    }
    // Token demo semeado: fluxo da sessão (compatível com a demonstração).
    acceptInvite(office);
    setTimeout(() => router.push("/app/dashboard"), 700);
  }

  // Estados de token inválido
  if (state !== "valid") {
    const info = BAD[state];
    return (
      <AuthShell title={info.title}>
        <div className={`state-box state-box--${info.tone === "err" ? "err" : "warn"}`}>
          <ShieldAlert size={20} aria-hidden />
          <span>{info.msg}</span>
        </div>
        <p className="auth__alt" style={{ marginTop: 18 }}>
          <Link href="/onboarding">Voltar ao onboarding</Link>
        </p>
      </AuthShell>
    );
  }

  // Regra: no máximo um escritório por pessoa
  const check = canAccept(office.id);
  if (!check.ok) {
    const isSame = check.reason === "already-member";
    return (
      <AuthShell title={isSame ? "Você já faz parte" : "Vínculo já existente"}>
        <div className={`state-box state-box--${isSame ? "info" : "warn"}`}>
          {isSame ? <Info size={20} aria-hidden /> : <ShieldAlert size={20} aria-hidden />}
          <span>
            {isSame
              ? `Você já participa de ${session.office?.name ?? "este escritório"}.`
              : `Você já participa de ${session.office?.name ?? "um escritório"}. Cada pessoa pode ter apenas um vínculo de escritório ativo. Saia do escritório atual antes de aceitar outro convite.`}
          </span>
        </div>
        <Link className="btn btn--primary btn--block" href="/app/dashboard" style={{ marginTop: 16 }}>
          Ir para o painel
        </Link>
      </AuthShell>
    );
  }

  // Convite válido e aceitável
  return (
    <AuthShell
      title="Convite para escritório"
      subtitle={<><strong>{inviter}</strong> convidou você para ingressar em:</>}
    >
      <div className="state-box state-box--info" style={{ alignItems: "center" }}>
        <Building2 size={20} aria-hidden />
        <span style={{ fontWeight: 700, color: "var(--text-strong)" }}>{office.name}</span>
      </div>

      <div className="form-note" style={{ marginTop: 16 }}>
        <ShieldCheck size={16} aria-hidden />
        <span>
          Ao ingressar, você entra como <strong>membro</strong> do escritório. Seus
          <strong> prazos pessoais permanecem privados</strong> — nada do seu ambiente
          pessoal é compartilhado ou transferido.
        </span>
      </div>

      <div className="form-note">
        <Info size={16} aria-hidden />
        <span>Convite demonstrativo: nenhum vínculo real é criado fora desta sessão.</span>
      </div>

      <Button variant="primary" block onClick={accept} disabled={loading}>
        {loading ? "Ingressando…" : "Ingressar no escritório"}
      </Button>
      <p className="auth__alt">
        <Link href="/onboarding" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          <Clock3 size={15} aria-hidden /> Agora não
        </Link>
      </p>
    </AuthShell>
  );
}
