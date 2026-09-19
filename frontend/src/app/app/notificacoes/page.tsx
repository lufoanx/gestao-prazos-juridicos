"use client";
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Bell, CheckCheck, Check } from "lucide-react";
import { useScope } from "@/context/ScopeContext";
import { useData } from "@/context/DataContext";
import { formatCivil } from "@/lib/dates.mjs";
import type { Notification } from "@/types/domain";
import { Badge, Button, Filters, EmptyState } from "@/components/ui";

export default function NotificacoesPage() {
  const router = useRouter();
  const { scope, scopeKind } = useScope();
  const { notifications, markNotificationRead, markAllNotificationsRead } = useData();
  const [filter, setFilter] = useState<"all" | "unread" | "read">("all");

  const inScope = (n: Notification) => {
    if (n.scope.kind !== scope.kind) return false;
    if (scope.kind === "personal" && n.scope.kind === "personal") return n.scope.ownerId === scope.ownerId;
    if (scope.kind === "office" && n.scope.kind === "office") return n.scope.officeId === scope.officeId;
    return false;
  };

  const scoped = useMemo(
    () => notifications.filter(inScope).sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [notifications, scope]
  );
  const unreadCount = scoped.filter((n) => !n.read).length;
  const shown = scoped.filter((n) => (filter === "all" ? true : filter === "unread" ? !n.read : n.read));

  return (
    <div>
      <div className="page-head">
        <div className="page-head__title">
          <h1 style={{ fontSize: "var(--fs-2xl)", fontWeight: 700, color: "var(--text-strong)", margin: 0 }}>Notificações</h1>
          <p className="page-head__subtitle">{scopeKind === "office" ? "Escritório" : "Ambiente pessoal"} · {unreadCount} não lida(s)</p>
        </div>
        <div className="page-head__actions">
          <Button variant="secondary" onClick={markAllNotificationsRead} disabled={unreadCount === 0}>
            <CheckCheck size={16} aria-hidden /> Marcar todas como lidas
          </Button>
        </div>
      </div>

      <Filters>
        <div className="toolbar__field field">
          <label className="field__label" htmlFor="f-nt">Exibir</label>
          <select id="f-nt" className="select" value={filter} onChange={(e) => setFilter(e.target.value as typeof filter)}>
            <option value="all">Todas</option>
            <option value="unread">Não lidas</option>
            <option value="read">Lidas</option>
          </select>
        </div>
      </Filters>

      {shown.length === 0 ? (
        <div className="card"><div className="card__body">
          <EmptyState icon={<Bell size={30} aria-hidden />} title="Nenhuma notificação">
            {scoped.length === 0 ? "Você está em dia neste ambiente." : "Nada para este filtro."}
          </EmptyState>
        </div></div>
      ) : (
        <div>
          {shown.map((n) => (
            <div key={n.id} className={`notif-row${n.read ? "" : " notif-row--unread"}`}>
              <div className="notif-row__main">
                <div className="notif-row__title">{n.title}</div>
                <div className="notif-row__meta">{formatCivil(n.createdAt)} · {n.read ? "lida" : "não lida"}</div>
              </div>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                {n.deadlineId ? (
                  <button className="btn btn--ghost btn--sm" onClick={() => router.push(`/app/prazos/${n.deadlineId}`)}>Ver prazo</button>
                ) : null}
                {!n.read ? (
                  <button className="btn btn--secondary btn--sm" onClick={() => markNotificationRead(n.id)}>
                    <Check size={15} aria-hidden /> Marcar lida
                  </button>
                ) : <Badge tone="neutral">Lida</Badge>}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
