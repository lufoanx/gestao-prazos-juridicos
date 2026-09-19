"use client";
import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Info, ArrowLeft } from "lucide-react";
import { OnboardingShell } from "@/components/public/OnboardingShell";
import { Select, Button } from "@/components/ui";
import { useSession } from "@/context/SessionContext";

const AREAS = ["Cível", "Trabalhista", "Criminal", "Tributário", "Família", "Previdenciário", "Empresarial", "Outros"];

export default function OnboardingAutonomoPage() {
  const router = useRouter();
  const { completeAutonomo } = useSession();
  const [area, setArea] = useState("");
  const [digest, setDigest] = useState("daily");
  const [loading, setLoading] = useState(false);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    // Preferências opcionais; autônomo NÃO recebe vínculo de escritório.
    completeAutonomo({
      practiceArea: area || undefined,
      digest: digest as "daily" | "weekly" | "none",
    });
    setTimeout(() => router.push("/app/dashboard"), 700);
  }

  return (
    <OnboardingShell
      title="Seu ambiente pessoal"
      subtitle="Ajustes opcionais para começar. Você pode alterá-los depois em Configurações."
    >
      <div className="form-note">
        <Info size={16} aria-hidden />
        <span>Tudo aqui é opcional e demonstrativo. Alertas e feriados oficiais serão configuráveis em etapa futura.</span>
      </div>
      <form className="auth__form" onSubmit={submit}>
        <Select
          label="Área de atuação principal (opcional)"
          value={area} onChange={(e) => setArea(e.target.value)}
          hint="Ajuda a organizar seus prazos por área."
        >
          <option value="">Prefiro não informar agora</option>
          {AREAS.map((a) => <option key={a} value={a}>{a}</option>)}
        </Select>
        <Select
          label="Resumo de prazos por e-mail (demonstrativo)"
          value={digest} onChange={(e) => setDigest(e.target.value)}
        >
          <option value="daily">Resumo diário</option>
          <option value="weekly">Resumo semanal</option>
          <option value="none">Não enviar</option>
        </Select>
        <Button type="submit" variant="primary" block disabled={loading}>
          {loading ? "Preparando painel…" : "Concluir e ir para o painel"}
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
