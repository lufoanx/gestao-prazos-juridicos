"use client";
import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Info, Clock3, ArrowLeft } from "lucide-react";
import { OnboardingShell } from "@/components/public/OnboardingShell";
import { Input, Button } from "@/components/ui";
import { useSession } from "@/context/SessionContext";
import { useOrg } from "@/context/OrgContext";

export default function SolicitarIngressoPage() {
  const router = useRouter();
  const { session } = useSession();
  const org = useOrg();
  const [code, setCode] = useState("");
  const [error, setError] = useState<string>();
  const [sent, setSent] = useState(false);
  const [loading, setLoading] = useState(false);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const officeId = code.trim();
    if (officeId.length < 4) { setError("Informe o código do escritório."); return; }
    if (!session.user) { setError("Entre na sua conta antes de solicitar ingresso."); router.push("/login"); return; }
    setError(undefined);
    setLoading(true);
    const res = org.requestJoin(officeId, session.user);
    setLoading(false);
    if (res.reason === "invalid") { setError("Escritório não encontrado para este código."); return; }
    if (res.reason === "already-member") { setError("Você já participa de um escritório. Saia dele antes de solicitar outro."); return; }
    // id presente (nova ou já pendente) → confirma
    setSent(true);
  }

  return (
    <OnboardingShell
      title="Ingressar em um escritório"
      subtitle={sent ? undefined : "Use o código informado pelo administrador do escritório."}
    >
      <div className="form-note">
        <Info size={16} aria-hidden />
        <span>
          Proposta em avaliação: identificar o escritório por um <strong>código compartilhado</strong>,
          com aprovação do administrador. A forma final ainda não foi decidida (não há diretório público).
        </span>
      </div>

      {sent ? (
        <>
          <div className="state-box state-box--info">
            <Clock3 size={20} aria-hidden />
            <span>
              Solicitação enviada para o escritório <strong>{code.trim()}</strong>.
              Ela fica <strong>pendente</strong> até um administrador aprovar ou recusar.
              Você será notificado do resultado.
            </span>
          </div>
          <p className="auth__alt" style={{ marginTop: 18 }}>
            Enquanto isso, você pode usar seu ambiente pessoal.
          </p>
          <Link className="btn btn--primary btn--block" href="/onboarding/autonomo" style={{ marginTop: 8 }}>
            Configurar ambiente pessoal
          </Link>
          <p className="auth__alt">
            <button className="form-link" style={{ background: "none", border: 0, cursor: "pointer" }} onClick={() => setSent(false)}>
              Enviar para outro código
            </button>
          </p>
        </>
      ) : (
        <>
          <form className="auth__form" onSubmit={submit} noValidate>
            <Input
              label="Código do escritório" required
              value={code} onChange={(e) => setCode(e.target.value)}
              error={error} placeholder="Ex.: office-demo"
              hint="O administrador do escritório fornece este código (id do escritório)."
            />
            <Button type="submit" variant="primary" block disabled={loading}>
              {loading ? "Enviando solicitação…" : "Enviar solicitação"}
            </Button>
          </form>
          <p className="auth__alt">
            <Link href="/onboarding" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              <ArrowLeft size={15} aria-hidden /> Voltar
            </Link>
          </p>
          <div className="form-note" style={{ marginTop: 4 }}>
            <Info size={16} aria-hidden />
            <span>Recebeu um <strong>convite por link</strong>? <Link className="form-link" href="/convite/demo">Abrir convite de exemplo</Link>.</span>
          </div>
        </>
      )}
    </OnboardingShell>
  );
}
