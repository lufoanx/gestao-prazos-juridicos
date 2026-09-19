import type { ReactNode } from "react";
import Link from "next/link";
import { Logo } from "@/components/brand/Logo";

interface AuthShellProps {
  title: string;
  subtitle?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}

/** Moldura das telas de acesso: logo (versão azul, fundo claro) + cartão central. */
export function AuthShell({ title, subtitle, children, footer }: AuthShellProps) {
  return (
    <main className="auth" id="conteudo">
      <div className="auth__card">
        <div className="auth__logo">
          <Link href="/" aria-label="Página inicial do PrazoAI"><Logo height={40} /></Link>
        </div>
        <h1 className="auth__title">{title}</h1>
        {subtitle ? <p className="auth__sub">{subtitle}</p> : null}
        {children}
      </div>
      {footer ? <div className="auth__foot">{footer}</div> : (
        <div className="auth__foot">Ambiente demonstrativo · sem autenticação real</div>
      )}
    </main>
  );
}
