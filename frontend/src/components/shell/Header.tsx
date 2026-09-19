"use client";
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Menu, Search, Bell, LogOut, BellOff } from "lucide-react";
import { useScope } from "@/context/ScopeContext";
import { useSession } from "@/context/SessionContext";
import { useData } from "@/context/DataContext";
import type { Notification, Scope } from "@/types/domain";
import { formatCivil } from "@/lib/dates.mjs";
import { Logo } from "@/components/brand/Logo";
import { ScopeSwitcher } from "./ScopeSwitcher";
import { SidebarNav } from "./Sidebar";
import {
  Avatar, Badge, Button, Drawer, EmptyState, ConfirmDialog, useToast,
} from "@/components/ui";

function inScope(n: Notification, scope: Scope) {
  if (n.scope.kind !== scope.kind) return false;
  if (n.scope.kind === "personal" && scope.kind === "personal") return n.scope.ownerId === scope.ownerId;
  if (n.scope.kind === "office" && scope.kind === "office") return n.scope.officeId === scope.officeId;
  return false;
}

export function Header() {
  const { user, membership, scope, scopeKind, office } = useScope();
  const toast = useToast();
  const router = useRouter();
  const { reset } = useSession();
  const [navOpen, setNavOpen] = useState(false);
  const [notifOpen, setNotifOpen] = useState(false);
  const [confirmOut, setConfirmOut] = useState(false);

  // Notificações do ambiente atual — recalculadas quando o escopo/dados mudam.
  const { notifications: allNotifications, markNotificationRead, markAllNotificationsRead } = useData();
  const notifications = useMemo(
    () => allNotifications.filter((n) => inScope(n, scope)),
    [allNotifications, scope]
  );
  const unread = notifications.filter((n) => !n.read).length;

  const roleLabel = scopeKind === "office"
    ? (membership?.roleLabel ?? "Escritório")
    : "Ambiente pessoal";

  return (
    <header className="app-header">
      <button
        className="icon-btn app-header__menu" aria-label="Abrir menu"
        onClick={() => setNavOpen(true)}
      >
        <Menu size={20} aria-hidden />
      </button>

      <div className="app-header__search">
        <Search size={16} aria-hidden />
        <label htmlFor="global-search" className="sr-only">Buscar prazos</label>
        <input
          id="global-search" className="input" type="search"
          placeholder="Buscar prazos, processos…"
          onKeyDown={(e) => {
            if (e.key === "Enter") toast.info("Busca demonstrativa", "A busca será conectada em etapa posterior.");
          }}
        />
      </div>

      <div className="app-header__spacer" />

      <div className="app-header__actions">
        <button
          className="icon-btn" aria-label={`Notificações${unread ? `, ${unread} não lidas` : ""}`}
          onClick={() => setNotifOpen(true)}
        >
          <Bell size={20} aria-hidden />
          {unread > 0 ? <span className="icon-btn__badge" aria-hidden>{unread}</span> : null}
        </button>

        <button className="user-btn" onClick={() => setConfirmOut(true)} aria-label="Menu da conta">
          <Avatar name={user.name} navy />
          <span>
            <span className="user-btn__name" style={{ display: "block" }}>{user.name}</span>
            <span className="user-btn__role">{roleLabel}</span>
          </span>
        </button>
      </div>

      {/* Drawer de navegação (mobile) */}
      <Drawer open={navOpen} onClose={() => setNavOpen(false)} side="left" navy ariaLabel="Navegação">
        <div className="app-sidebar__brand" style={{ borderBottom: "1px solid rgba(255,255,255,.08)" }}>
          <Logo height={34} onDark />
        </div>
        <div className="app-sidebar__scope"><ScopeSwitcher /></div>
        <SidebarNav />
      </Drawer>

      {/* Drawer de notificações */}
      <Drawer
        open={notifOpen} onClose={() => setNotifOpen(false)} side="right"
        title={`Notificações · ${scopeKind === "office" ? (office?.name ?? "Escritório") : "Pessoal"}`}
      >
        {notifications.length === 0 ? (
          <EmptyState icon={<BellOff size={30} aria-hidden />} title="Sem notificações">
            Nada por aqui neste ambiente.
          </EmptyState>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
              <Button variant="ghost" onClick={markAllNotificationsRead} disabled={unread === 0}>Marcar todas como lidas</Button>
              <button className="btn btn--ghost btn--sm" onClick={() => { setNotifOpen(false); router.push("/app/notificacoes"); }}>Ver todas</button>
            </div>
            {notifications.map((n) => (
              <div key={n.id} className="card" style={{ padding: 12 }}>
                <div style={{ display: "flex", gap: 8, alignItems: "center", justifyContent: "space-between" }}>
                  {!n.read ? <Badge tone="teal" dot>Nova</Badge> : <Badge tone="neutral">Lida</Badge>}
                  {!n.read ? (
                    <button className="btn btn--secondary btn--sm" onClick={() => markNotificationRead(n.id)}>Marcar lida</button>
                  ) : null}
                </div>
                <div style={{ fontWeight: 600, color: "var(--text-strong)", marginTop: 6, fontSize: "var(--fs-sm)" }}>
                  {n.title}
                </div>
                <div style={{ fontSize: "var(--fs-xs)", color: "var(--muted)", marginTop: 2 }}>
                  {formatCivil(n.createdAt)}
                </div>
              </div>
            ))}
          </div>
        )}
      </Drawer>

      {/* Encerrar sessão demonstrativa */}
      <ConfirmDialog
        open={confirmOut}
        title="Encerrar sessão demonstrativa?"
        message="Isto apenas simula a saída. Nenhum dado real é afetado — o PrazoAI está em modo demonstrativo."
        confirmLabel="Encerrar sessão"
        cancelLabel="Continuar"
        danger
        onCancel={() => setConfirmOut(false)}
        onConfirm={() => {
          setConfirmOut(false);
          // Encerra a sessão demonstrativa (limpa nome, e-mail, perfil e escritório)
          // e retorna ao login, fechando o ciclo dos fluxos.
          reset();
          router.push("/login");
        }}
      />
    </header>
  );
}
