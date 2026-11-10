"use client";
// Casca do MODO INTEGRADO: proteção de rota no cliente (o servidor é a autoridade), seleção de
// ambiente (contexto de navegação, nunca autorização) e módulos ainda não integrados identificados.
import { useEffect, type ReactNode } from "react";
import { usePathname, useRouter } from "next/navigation";
import { LogOut } from "lucide-react";
import { useAuth } from "./AuthProvider";
import { useOrg } from "./OrgProvider";
import { UnreadCount } from "./IntegratedNotifications";

const NAV = [
  { href: "/app", label: "Início", ready: true },
  { href: "/app/escritorio", label: "Escritório", ready: true, office: true },
  { href: "/app/escritorio/equipe", label: "Equipe", ready: true, office: true },
  { href: "/app/perfil", label: "Perfil", ready: true },
  { href: "/app/dashboard", label: "Dashboard", ready: false },
  { href: "/app/prazos", label: "Prazos", ready: true },
  { href: "/app/calendario", label: "Calendário", ready: true },
  { href: "/app/intimacoes", label: "Intimações", ready: true },
  { href: "/app/notificacoes", label: "Notificações", ready: true },
];

export function IntegratedShell({ children }: { children: ReactNode }) {
  const { state, controller } = useAuth();
  const { state: org, controller: orgCtl } = useOrg();
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

  const hasOffice = Boolean(org.office);
  // A chave remonta o conteúdo ao trocar usuário/escritório/ambiente OU a revisão de autorização:
  // dados renderizados, formulários abertos e seleções incompatíveis são descartados.
  const contentKey = `${state.user.id}|${org.office?.id ?? "-"}|${org.scope}|r${org.revision}`;

  return (
    <div className="app-shell">
      <aside className="app-sidebar">
        <div className="app-sidebar__brand">PrazoAI</div>
        <nav className="app-nav" aria-label="Navegação principal">
          {NAV.filter((i) => !i.office || hasOffice).map((item) => (
            <a key={item.href} href={item.href} className="app-nav__link"
               aria-current={pathname === item.href || (["/app/prazos", "/app/intimacoes"].includes(item.href) && pathname.startsWith(`${item.href}/`)) ? "page" : undefined}>
              {item.label}{item.href === "/app/notificacoes" && org.status === "ready" ? <UnreadCount key={contentKey} /> : null}
              {!item.ready && <span className="text-muted"> · em integração</span>}
            </a>
          ))}
        </nav>
      </aside>
      <div className="app-main">
        <header className="app-header">
          <label className="text-muted" style={{ display: "flex", alignItems: "center", gap: 8 }}>
            Ambiente
            <select className="select" aria-label="Ambiente" value={org.scope}
              onChange={(e) => orgCtl.selectScope(e.target.value as "personal" | "office")}>
              <option value="personal">Pessoal</option>
              {org.office ? <option value="office">Escritório: {org.office.name}</option> : null}
            </select>
          </label>
          <span className="app-header__spacer" />
          <div className="app-header__actions">
            <span className="user-btn__name">{state.user.name}</span>
            <button className="btn btn--ghost btn--sm" onClick={async () => { await controller.logout(); router.replace("/login"); }}>
              <LogOut size={16} aria-hidden /> Sair
            </button>
          </div>
        </header>
        <main className="app-content" id="conteudo" key={contentKey}>
          {org.status === "unavailable" ? (
            <p role="alert" className="field__error">Não foi possível carregar o vínculo com escritório (serviço indisponível).
              {" "}<button className="btn btn--secondary btn--sm" onClick={() => void orgCtl.revalidate()}>Tentar novamente</button></p>
          ) : null}
          {children}
        </main>
      </div>
    </div>
  );
}
