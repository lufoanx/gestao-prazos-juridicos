"use client";
import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Info, ArrowLeft, ShieldAlert } from "lucide-react";
import { OnboardingShell } from "@/components/public/OnboardingShell";
import { Input, Select, Button } from "@/components/ui";
import { useSession } from "@/context/SessionContext";
import { useOrg } from "@/context/OrgContext";

const AREAS = ["Cível", "Trabalhista", "Criminal", "Tributário", "Família", "Previdenciário", "Empresarial", "Outros"];

export default function OnboardingEscritorioPage() {
  const router = useRouter();
  const { session, createOffice } = useSession();
  const { myOfficeMembership, offices } = useOrg();
  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const [area, setArea] = useState("");
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);

  // Bloqueio: vínculo ativo na SESSÃO ou no ROSTER compartilhado (mesmo após logout/login).
  const existingOffice = session.office ?? (myOfficeMembership ? offices.find((o) => o.id === myOfficeMembership.officeId) ?? null : null);
  if (existingOffice) {
    return (
      <OnboardingShell title="Você já tem um escritório">
        <div className="state-box state-box--warn">
          <ShieldAlert size={20} aria-hidden />
          <span>
            Você já participa de <strong>{existingOffice.name}</strong>. Cada pessoa pode
            manter apenas <strong>um escritório ativo</strong>. Para criar um novo, saia
            do escritório atual primeiro (disponível nas configurações de escritório).
          </span>
        </div>
        <Link className="btn btn--primary btn--block" href="/app/dashboard" style={{ marginTop: 16 }}>
          Ir para o painel
        </Link>
        <p className="auth__alt">
          <Link href="/onboarding" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            <ArrowLeft size={15} aria-hidden /> Voltar
          </Link>
        </p>
      </OnboardingShell>
    );
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (name.trim().length < 2) { setError("Informe o nome do escritório."); return; }
    setError(undefined);
    // Cria o escritório e entra como ADMINISTRADOR do ambiente criado.
    const result = createOffice({ name, role: role || undefined, area: area || undefined });
    if (!result.ok) {
      // Salvaguarda: vínculo surgido em outra aba. Não substitui nada.
      setError("Você já participa de um escritório. Não é possível criar outro.");
      return;
    }
    setLoading(true);
    setTimeout(() => router.push("/app/dashboard"), 800);
  }

  return (
    <OnboardingShell
      title="Criar escritório"
      subtitle="Você será o administrador. Depois poderá convidar a equipe e definir permissões."
    >
      <div className="form-note">
        <Info size={16} aria-hidden />
        <span>Criação demonstrativa: o escritório existe apenas nesta sessão. Convites e permissões detalhadas chegam nas próximas etapas.</span>
      </div>
      <form className="auth__form" onSubmit={submit} noValidate>
        <Input
          label="Nome do escritório" required
          value={name} onChange={(e) => setName(e.target.value)} error={error}
          placeholder="Ex.: Andrade & Associados"
        />
        <Input
          label="Seu cargo no escritório (opcional)"
          value={role} onChange={(e) => setRole(e.target.value)}
          placeholder="Ex.: Advogada responsável"
        />
        <Select
          label="Área principal do escritório (opcional)"
          value={area} onChange={(e) => setArea(e.target.value)}
        >
          <option value="">Prefiro não informar agora</option>
          {AREAS.map((a) => <option key={a} value={a}>{a}</option>)}
        </Select>
        <Button type="submit" variant="primary" block disabled={loading}>
          {loading ? "Criando escritório…" : "Criar e ir para o painel"}
        </Button>
      </form>
      <p className="auth__alt">
        <Link href="/onboarding" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          <ArrowLeft size={15} aria-hidden /> Voltar
        </Link>
      </p>
    </OnboardingShell>
  );
}
