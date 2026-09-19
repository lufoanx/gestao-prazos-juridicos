"use client";
import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Info } from "lucide-react";
import { AuthShell } from "@/components/public/AuthShell";
import { PasswordInput } from "@/components/public/PasswordInput";
import { GoogleDemoButton } from "@/components/public/GoogleDemoButton";
import { Input, Button } from "@/components/ui";
import { useSession } from "@/context/SessionContext";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Nome amigável derivado do e-mail (apenas demonstrativo).
function nameFromEmail(email: string): string {
  const local = email.split("@")[0] || "";
  const parts = local.split(/[._-]+/).filter(Boolean);
  if (parts.length === 0) return "Usuário demonstrativo";
  return parts.map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join(" ");
}

export default function LoginPage() {
  const router = useRouter();
  const { signIn } = useSession();
  const [email, setEmail] = useState("");
  const [pw, setPw] = useState("");
  const [errors, setErrors] = useState<{ email?: string; pw?: string }>({});
  const [loading, setLoading] = useState(false);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const next: typeof errors = {};
    if (!EMAIL_RE.test(email)) next.email = "Informe um e-mail válido.";
    if (pw.length < 1) next.pw = "Informe sua senha.";
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    setLoading(true);
    // Login demonstrativo: sem autenticação real, apenas simula o acesso.
    signIn({ email, name: nameFromEmail(email) });
    setTimeout(() => router.push("/app/dashboard"), 700);
  }

  return (
    <AuthShell title="Entrar" subtitle="Acesse seu painel de prazos.">
      <div className="form-note">
        <Info size={16} aria-hidden />
        <span>Acesso demonstrativo: qualquer e-mail válido e senha entram no painel. Nenhuma credencial é verificada ou armazenada.</span>
      </div>

      <form className="auth__form" onSubmit={submit} noValidate>
        <Input
          label="E-mail" type="email" autoComplete="email" required
          value={email} onChange={(e) => setEmail(e.target.value)}
          error={errors.email} placeholder="voce@exemplo.com.br"
        />
        <PasswordInput
          label="Senha" autoComplete="current-password" required
          value={pw} onChange={(e) => setPw(e.target.value)}
          error={errors.pw}
        />
        <div className="auth__row">
          <span />
          <Link href="/esqueci-senha">Esqueci minha senha</Link>
        </div>
        <Button type="submit" variant="primary" block disabled={loading}>
          {loading ? "Entrando…" : "Entrar"}
        </Button>
      </form>

      <div className="divider">ou</div>
      <GoogleDemoButton label="Entrar com Google" onProceed={() => { signIn({ email: "demo.google@exemplo.com", name: "Usuário Google (demo)" }); router.push("/app/dashboard"); }} />

      <p className="auth__alt">
        Não tem conta? <Link href="/cadastro">Criar conta</Link>
      </p>
    </AuthShell>
  );
}
