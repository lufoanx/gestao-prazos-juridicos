"use client";
import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AuthShell } from "@/components/public/AuthShell";
import { PasswordInput } from "@/components/public/PasswordInput";
import { Input, Button } from "@/components/ui";
import { ApiError, StaleResponseError } from "@/lib/integration/api-client.mjs";
import { useAuth } from "./AuthProvider";
import { errorMessage } from "./messages";
import { UnavailableNote } from "./Unavailable";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function IntegratedLogin() {
  const router = useRouter();
  const { controller, state } = useAuth();
  const [email, setEmail] = useState("");
  const [pw, setPw] = useState("");
  const [errors, setErrors] = useState<{ email?: string; pw?: string; form?: string }>({});
  const [loading, setLoading] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const next: typeof errors = {};
    if (!EMAIL_RE.test(email)) next.email = "Informe um e-mail válido.";
    if (pw.length < 1) next.pw = "Informe sua senha.";
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    setLoading(true);
    try {
      await controller.login(email.trim(), pw);
      setPw("");
      router.push("/app");
    } catch (err) {
      // login_cancelled (servidor) ou resposta descartada porque outra aba encerrou a sessão.
      const cancelled = (err instanceof ApiError && err.code === "login_cancelled") || err instanceof StaleResponseError;
      const resync = err instanceof ApiError && err.code === "session_resync_required";
      const msg = err instanceof ApiError && err.code === "invalid_credentials"
        ? "E-mail ou senha inválidos."
        : cancelled
          ? "O login foi cancelado porque a sessão foi encerrada em outra aba. Entre novamente."
          : resync
            ? "A sessão anterior deste navegador terminou. Entre novamente."
            : errorMessage(err);
      setErrors({ form: msg });
    } finally {
      setLoading(false);
    }
  }

  return (
    <AuthShell title="Entrar" subtitle="Acesse seu painel de prazos.">
      {state.status === "expired" && (
        <div className="form-note" role="status"><span>Sua sessão terminou. Entre novamente.</span></div>
      )}
      <form className="auth__form" onSubmit={submit} noValidate aria-label="Entrar">
        <Input label="E-mail" type="email" autoComplete="email" required value={email}
          onChange={(e) => setEmail(e.target.value)} error={errors.email} placeholder="voce@exemplo.com.br" />
        <PasswordInput label="Senha" autoComplete="current-password" required value={pw}
          onChange={(e) => setPw(e.target.value)} error={errors.pw} />
        {errors.form && <p className="field__error" role="alert">{errors.form}</p>}
        <div className="auth__row">
          <span />
          <span className="text-muted" title="Recuperação por e-mail indisponível nesta fase">Esqueci minha senha (indisponível)</span>
        </div>
        <Button type="submit" variant="primary" block disabled={loading}>{loading ? "Entrando…" : "Entrar"}</Button>
      </form>
      <div className="divider">ou</div>
      <UnavailableNote feature="Entrar com Google" reason="O login com Google ainda não está disponível nesta fase." />
      <p className="auth__alt">Não tem conta? <Link href="/cadastro">Criar conta</Link></p>
    </AuthShell>
  );
}
