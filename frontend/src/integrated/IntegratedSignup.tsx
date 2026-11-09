"use client";
import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AuthShell } from "@/components/public/AuthShell";
import { PasswordInput } from "@/components/public/PasswordInput";
import { Input, Button } from "@/components/ui";
import { ApiError } from "@/lib/integration/api-client.mjs";
import { useAuth } from "./AuthProvider";
import { errorMessage } from "./messages";
import { UnavailableNote } from "./Unavailable";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Mesma política do backend: 8 a 128 caracteres, sem ser só espaços (o servidor é a autoridade).
export function passwordProblem(pw: string): string | undefined {
  if (pw.length < 8) return "A senha deve ter pelo menos 8 caracteres.";
  if (pw.length > 128) return "A senha deve ter no máximo 128 caracteres.";
  if (!pw.trim()) return "A senha não pode ser composta só de espaços.";
  return undefined;
}

export function IntegratedSignup() {
  const router = useRouter();
  const { controller } = useAuth();
  const [form, setForm] = useState({ name: "", email: "", pw: "", pw2: "" });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value });

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const next: Record<string, string> = {};
    if (form.name.trim().length < 1) next.name = "Informe seu nome.";
    if (!EMAIL_RE.test(form.email)) next.email = "Informe um e-mail válido.";
    const pwErr = passwordProblem(form.pw);
    if (pwErr) next.pw = pwErr;
    if (form.pw !== form.pw2) next.pw2 = "As senhas não coincidem.";
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    setLoading(true);
    try {
      await controller.register(form.name.trim(), form.email.trim(), form.pw);
      await controller.login(form.email.trim(), form.pw);
      router.push("/app");
    } catch (err) {
      const msg = err instanceof ApiError && err.code === "email_already_registered"
        ? "Este e-mail já está cadastrado." : errorMessage(err);
      setErrors({ form: msg });
    } finally {
      setForm((f) => ({ ...f, pw: "", pw2: "" }));
      setLoading(false);
    }
  }

  return (
    <AuthShell title="Criar conta" subtitle="Comece a organizar seus prazos.">
      <form className="auth__form" onSubmit={submit} noValidate aria-label="Criar conta">
        <Input label="Nome" autoComplete="name" required value={form.name} onChange={set("name")} error={errors.name} />
        <Input label="E-mail" type="email" autoComplete="email" required value={form.email} onChange={set("email")} error={errors.email} />
        <PasswordInput label="Senha" autoComplete="new-password" required value={form.pw} onChange={set("pw")} error={errors.pw} />
        <PasswordInput label="Confirmar senha" autoComplete="new-password" required value={form.pw2} onChange={set("pw2")} error={errors.pw2} />
        {errors.form && <p className="field__error" role="alert">{errors.form}</p>}
        <Button type="submit" variant="primary" block disabled={loading}>{loading ? "Criando…" : "Criar conta"}</Button>
      </form>
      <div className="divider">ou</div>
      <UnavailableNote feature="Criar conta com Google" reason="O cadastro com Google ainda não está disponível nesta fase." />
      <p className="auth__alt">Já tem conta? <Link href="/login">Entrar</Link></p>
    </AuthShell>
  );
}
