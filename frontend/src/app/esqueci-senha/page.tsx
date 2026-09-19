"use client";
import { useState } from "react";
import Link from "next/link";
import { Info, MailCheck } from "lucide-react";
import { AuthShell } from "@/components/public/AuthShell";
import { Input, Button } from "@/components/ui";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function EsqueciSenhaPage() {
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string>();
  const [sent, setSent] = useState(false);
  const [loading, setLoading] = useState(false);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!EMAIL_RE.test(email)) { setError("Informe um e-mail válido."); return; }
    setError(undefined);
    setLoading(true);
    // Envio neutro: não revela se o e-mail existe (evita enumeração de contas).
    setTimeout(() => { setLoading(false); setSent(true); }, 700);
  }

  return (
    <AuthShell
      title="Recuperar senha"
      subtitle={sent ? undefined : "Enviaremos um link para redefinir sua senha."}
    >
      {sent ? (
        <>
          <div className="state-box state-box--ok">
            <MailCheck size={20} aria-hidden />
            <span>
              Se houver uma conta associada a <strong>{email}</strong>, você receberá um
              e-mail com o link para redefinir a senha. Verifique também a caixa de spam.
            </span>
          </div>
          <div className="form-note" style={{ marginTop: 16 }}>
            <Info size={16} aria-hidden />
            <span>
              Nesta versão demonstrativa nenhum e-mail é enviado de fato. Use o link
              abaixo para simular a redefinição.
            </span>
          </div>
          <Link className="btn btn--primary btn--block" href="/redefinir-senha/demo" style={{ marginTop: 12 }}>
            Abrir link de redefinição (demo)
          </Link>
          <p className="auth__alt"><Link href="/login">Voltar para entrar</Link></p>
        </>
      ) : (
        <>
          <div className="form-note">
            <Info size={16} aria-hidden />
            <span>Fluxo demonstrativo: nenhum e-mail real é enviado.</span>
          </div>
          <form className="auth__form" onSubmit={submit} noValidate>
            <Input
              label="E-mail" type="email" autoComplete="email" required
              value={email} onChange={(e) => setEmail(e.target.value)}
              error={error} placeholder="voce@exemplo.com.br"
            />
            <Button type="submit" variant="primary" block disabled={loading}>
              {loading ? "Enviando…" : "Enviar link"}
            </Button>
          </form>
          <p className="auth__alt"><Link href="/login">Voltar para entrar</Link></p>
        </>
      )}
    </AuthShell>
  );
}
