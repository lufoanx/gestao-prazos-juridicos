"use client";
// Casca do MODO INTEGRADO (6.1): proteção de rota no cliente (o servidor é a autoridade),
// navegação com módulos ainda não integrados identificados e estados distintos de sessão.
import { useEffect, type ReactNode } from "react";
import { usePathname, useRouter } from "next/navigation";
import { LogOut } from "lucide-react";
import { useAuth } from "./AuthProvider";

const NAV = [
  { href: "/app", label: "Início", ready: true },
  { href: "/app/perfil", label: "Perfil", ready: true },
  { href: "/app/dashboard", label: "Dashboard", ready: false },
  { href: "/app/prazos", label: "Prazos", ready: false },
  { href: "/app/calendario", label: "Calendário", ready: false },
  { href: "/app/intimacoes", label: "Intimações", ready: false },
  { href: "/app/notificacoes", label: "Notificações", ready: false },
  { href: "/app/escritorio", label: "Escritório", ready: false },
];

export function IntegratedShell({ children }: { children: ReactNode }) {
  const { state, controller } = useAuth();
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (state.status === "anonymous" || state.status === "expired") router.replace("/login");
  }, [state.status, router]);

  if (state.status === "loading") {
    return <div className="app-shell"><main className="app-content" id="conteudo" aria-busy="true">Carregando sessão…</main></div>;
  }
  if (state.status === "unavailable") {
    return (
      <div className="app-shell"><main className="app-content" id="conteudo">
        <div className="card"><div className="card__body" role="alert">
          <h1 style={{ fontSize: "var(--fs-xl)" }}>Serviço indisponível</h1>
          <p className="text-muted">Não foi possível falar com o servidor. Nenhum dado demonstrativo é exibido.</p>
          <button className="btn btn--secondary btn--sm" onClick={() => void controller.restore()}>Tentar novamente</button>
        </div></div>
      </main></div>
    );
  }
  if (state.status !== "authenticated" || !state.user) return null;

  return (
    <div className="app-shell">
      <aside className="app-sidebar">
        <div className="app-sidebar__brand">PrazoAI</div>
        <nav className="app-nav" aria-label="Navegação principal">
          {NAV.map((item) => (
            <a key={item.href} href={item.href} className="app-nav__link"
               aria-current={pathname === item.href ? "page" : undefined}>
              {item.label}{!item.ready && <span className="text-muted"> · em integração</span>}
            </a>
          ))}
        </nav>
      </aside>
      <div className="app-main">
        <header className="app-header">
          <span className="app-header__spacer" />
          <div className="app-header__actions">
            <span className="user-btn__name">{state.user.name}</span>
            <button className="btn btn--ghost btn--sm" onClick={async () => { await controller.logout(); router.replace("/login"); }}>
              <LogOut size={16} aria-hidden /> Sair
            </button>
          </div>
        </header>
        <main className="app-content" id="conteudo">{children}</main>
      </div>
    </div>
  );
}
