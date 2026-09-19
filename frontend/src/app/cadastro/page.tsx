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

export default function CadastroPage() {
  const router = useRouter();
  const { signUp } = useSession();
  const [form, setForm] = useState({ name: "", email: "", pw: "", pw2: "" });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const next: Record<string, string> = {};
    if (form.name.trim().length < 2) next.name = "Informe seu nome completo.";
    if (!EMAIL_RE.test(form.email)) next.email = "Informe um e-mail válido.";
    if (form.pw.length < 8) next.pw = "Use ao menos 8 caracteres.";
    if (form.pw2 !== form.pw) next.pw2 = "As senhas não coincidem.";
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    setLoading(true);
    // Cadastro somente em memória (nada de senha é guardado). Segue para o onboarding.
    signUp({ name: form.name, email: form.email });
    setTimeout(() => router.push("/onboarding"), 800);
  }

  return (
    <AuthShell title="Criar conta" subtitle="Comece a organizar seus prazos.">
      <div className="form-note">
        <Info size={16} aria-hidden />
        <span>Cadastro demonstrativo: a conta existe apenas nesta sessão, sem armazenamento real. A OAB não é pedida agora.</span>
      </div>

      <form className="auth__form" onSubmit={submit} noValidate>
        <Input
          label="Nome completo" autoComplete="name" required
          value={form.name} onChange={set("name")} error={errors.name}
        />
        <Input
          label="E-mail" type="email" autoComplete="email" required
          value={form.email} onChange={set("email")} error={errors.email}
          placeholder="voce@exemplo.com.br"
        />
        <PasswordInput
          label="Senha" autoComplete="new-password" required
          value={form.pw} onChange={set("pw")} error={errors.pw}
          hint="Mínimo de 8 caracteres."
        />
        <PasswordInput
          label="Confirmar senha" autoComplete="new-password" required
          value={form.pw2} onChange={set("pw2")} error={errors.pw2}
        />
        <Button type="submit" variant="primary" block disabled={loading}>
          {loading ? "Criando conta…" : "Criar conta"}
        </Button>
      </form>

      <div className="divider">ou</div>
      <GoogleDemoButton label="Criar conta com Google" onProceed={() => { signUp({ name: "Usuário Google (demo)", email: "demo.google@exemplo.com" }); router.push("/onboarding"); }} />

      <p className="auth__alt">
        Já tem conta? <Link href="/login">Entrar</Link>
      </p>
    </AuthShell>
  );
}
