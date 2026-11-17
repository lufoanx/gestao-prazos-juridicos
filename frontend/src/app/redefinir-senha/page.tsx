"use client";
// MODO DEMONSTRAÇÃO (no modo integrado o layout renderiza a tela real). Mesmo formato de link do
// fluxo real (/redefinir-senha#…), com códigos demonstrativos no fragmento:
// "#demo" = válido · "#expirado" · "#usado" · ausente ou outro = inválido. Nada é enviado.
import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Info, ShieldAlert, CheckCircle2 } from "lucide-react";
import { AuthShell } from "@/components/public/AuthShell";
import { PasswordInput } from "@/components/public/PasswordInput";
import { Button } from "@/components/ui";

type DemoState = "reading" | "valid" | "expired" | "used" | "invalid";

function resolveDemo(code: string): DemoState {
  if (code === "demo") return "valid";
  if (code === "expirado") return "expired";
  if (code === "usado") return "used";
  return "invalid";
}

const BAD_COPY: Record<"expired" | "used" | "invalid", string> = {
  expired: "Este link de redefinição expirou. Solicite um novo para continuar.",
  used: "Este link já foi utilizado. Solicite um novo se precisar redefinir novamente.",
  invalid: "Este link de redefinição é inválido ou está incompleto.",
};

export default function RedefinirSenhaDemoPage() {
  const router = useRouter();
  const [state, setState] = useState<DemoState>("reading");
  const [form, setForm] = useState({ pw: "", pw2: "" });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [done, setDone] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const code = window.location.hash.slice(1);
    if (window.location.hash) window.history.replaceState(null, "", window.location.pathname);
    setState((s) => (s === "reading" ? resolveDemo(code) : s));            // efeito repetido não relê
  }, []);

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const next: Record<string, string> = {};
    if (form.pw.length < 8) next.pw = "Use ao menos 8 caracteres.";
    if (form.pw2 !== form.pw) next.pw2 = "As senhas não coincidem.";
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    setLoading(true);
    setTimeout(() => { setLoading(false); setDone(true); }, 700);
  }

  if (state === "reading") return <AuthShell title="Redefinir senha"><p aria-busy="true">Lendo o link…</p></AuthShell>;

  if (done) {
    return (
      <AuthShell title="Senha redefinida">
        <div className="state-box state-box--ok">
          <CheckCircle2 size={20} aria-hidden />
          <span>Sua senha foi redefinida (simulação). Você já pode entrar com a nova senha.</span>
        </div>
        <Button variant="primary" block onClick={() => router.push("/login")} style={{ marginTop: 16 }}>
          Ir para o login
        </Button>
      </AuthShell>
    );
  }

  if (state !== "valid") {
    return (
      <AuthShell title="Link indisponível">
        <div className="state-box state-box--warn">
          <ShieldAlert size={20} aria-hidden />
          <span>{BAD_COPY[state]}</span>
        </div>
        <Link className="btn btn--primary btn--block" href="/esqueci-senha" style={{ marginTop: 16 }}>
          Solicitar novo link
        </Link>
        <p className="auth__alt"><Link href="/login">Voltar para entrar</Link></p>
      </AuthShell>
    );
  }

  return (
    <AuthShell title="Redefinir senha" subtitle="Escolha uma nova senha para sua conta.">
      <div className="form-note">
        <Info size={16} aria-hidden />
        <span>Fluxo demonstrativo: a nova senha não é armazenada.</span>
      </div>
      <form className="auth__form" onSubmit={submit} noValidate>
        <PasswordInput
          label="Nova senha" autoComplete="new-password" required
          value={form.pw} onChange={set("pw")} error={errors.pw}
          hint="Mínimo de 8 caracteres."
        />
        <PasswordInput
          label="Confirmar nova senha" autoComplete="new-password" required
          value={form.pw2} onChange={set("pw2")} error={errors.pw2}
        />
        <Button type="submit" variant="primary" block disabled={loading}>
          {loading ? "Salvando…" : "Redefinir senha"}
        </Button>
      </form>
      <p className="auth__alt"><Link href="/login">Voltar para entrar</Link></p>
    </AuthShell>
  );
}
