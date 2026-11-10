"use client";
// Caixa de notificações internas (6.4). Listagem, contagem e marcações vêm do SERVIDOR, sempre
// para o ambiente selecionado e com a autorização atual (notificações de recursos que você não
// pode mais ver ficam ocultas). Não são lembretes de vencimento.
import { useEffect, useState } from "react";
import Link from "next/link";
import { Badge, Button, EmptyState, Pagination } from "@/components/ui";
import { notificationHref } from "@/lib/integration/intimations-client.mjs";
import { formatCivilDate } from "@/lib/integration/civil-date.mjs";
import type { InboxNotification, NotificationPage } from "@/lib/integration/dto.d.mts";
import { useResource } from "./useResource";
import { NOTIFICATIONS_CHANGED, announceNotificationsChanged, useIntimationContext } from "./intimationShared";
import { Card, Notice, PageHead, ResourceState, fmtDate, useMutation } from "./ui";

const KIND = { deadline_assigned: "Prazo atribuído a você", intimation_assigned: "Intimação atribuída a você" } as Record<string, string>;

function summaryText(n: InboxNotification): string {
  const s = n.summary as Record<string, string | null | undefined>;
  if (n.resourceType === "deadline") return `${s.title ?? "Prazo"} · processo ${s.caseNumber ?? "—"} · vence ${formatCivilDate(s.dueDate ?? null)}`;
  return `${s.title || s.fileName || "Intimação"}`;
}

/** Contador de não lidas do ambiente atual (servidor). Atualiza no foco e após ações relevantes. */
export function UnreadCount() {
  const { notifications, scope } = useIntimationContext();
  const res = useResource<{ unread: number }>("notifications:unread", () => notifications.unreadCount(scope));
  const { reload } = res;
  useEffect(() => {
    window.addEventListener("focus", reload);
    window.addEventListener(NOTIFICATIONS_CHANGED, reload);
    return () => { window.removeEventListener("focus", reload); window.removeEventListener(NOTIFICATIONS_CHANGED, reload); };
  }, [reload]);
  if (res.status !== "ready" || res.data.unread === 0) return null;
  return <span data-testid="unread-badge" aria-label={`${res.data.unread} notificações não lidas`}> ({res.data.unread})</span>;
}

export function IntegratedNotifications() {
  const { notifications, scope, org } = useIntimationContext();
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [page, setPage] = useState(1);
  const res = useResource<NotificationPage>(`notifications:list:u${unreadOnly ? 1 : 0}:p${page}`,
    () => notifications.list({ scope, unreadOnly, page, perPage: 20 }));
  const one = useMutation();
  const all = useMutation();
  const [ok, setOk] = useState<string | null>(null);
  const { reload } = res;
  useEffect(() => {
    window.addEventListener("focus", reload);
    return () => window.removeEventListener("focus", reload);
  }, [reload]);

  if (org.status !== "ready") return <p aria-busy="true">Carregando…</p>;
  const refresh = () => { reload(); announceNotificationsChanged(); };

  return (
    <div>
      <PageHead title="Notificações">
        <Button variant="secondary" size="sm" onClick={refresh}>Atualizar</Button>
      </PageHead>
      <p className="text-muted">
        Avisos internos de atribuição no ambiente {scope === "office" ? `do escritório “${org.office?.name ?? ""}”` : "pessoal"}.
        Não são lembretes de vencimento{scope === "personal" ? "; nesta etapa não há notificações pessoais" : ""}.
      </p>
      <label style={{ display: "inline-flex", gap: 6, alignItems: "center", marginBottom: 8 }}>
        <input type="checkbox" checked={unreadOnly} onChange={(e) => { setUnreadOnly(e.target.checked); setPage(1); }} /> Somente não lidas
      </label>
      {ok ? <Notice kind="ok">{ok}</Notice> : null}
      {one.error ? <Notice kind="error">{one.error}</Notice> : null}
      {all.error ? <Notice kind="error">{all.error}</Notice> : null}
      <ResourceState res={res}>{(data) => (
        <>
          <p className="result-count" data-testid="notification-count">{data.total} notificação(ões) · {data.unread} não lida(s)</p>
          {data.unread > 0 ? (
            <Button size="sm" disabled={all.busy} onClick={async () => {
              setOk(null);
              const r = await all.run(() => notifications.readAll(scope));        // todas do ambiente, não só a página
              if (r.ok) { setOk(`${r.value.marked} notificação(ões) marcada(s) como lida(s).`); refresh(); }
            }}>Marcar todas como lidas</Button>
          ) : null}
          <Card>
            {data.items.length === 0 ? <EmptyState title={unreadOnly ? "Nenhuma notificação não lida." : "Nenhuma notificação."} /> : (
              <ul aria-label="Notificações" style={{ listStyle: "none", padding: 0 }}>
                {data.items.map((n) => {
                  const href = notificationHref(n);
                  return (
                    <li key={n.id} data-testid="notification" style={{ padding: "8px 0", borderBottom: "1px solid var(--border, #eee)" }}>
                      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                        {n.readAt ? <Badge tone="neutral">Lida</Badge> : <Badge tone="info">Nova</Badge>}
                        <strong>{KIND[n.kind] ?? "Notificação"}</strong>
                        <span className="text-muted">{fmtDate(n.createdAt)}</span>
                      </div>
                      <div>{summaryText(n)}</div>
                      <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
                        {href ? <Link href={href}>Abrir</Link> : null}
                        {!n.readAt ? (
                          <Button variant="ghost" size="sm" disabled={one.busy} onClick={async () => {
                            setOk(null);
                            if ((await one.run(() => notifications.markRead(n.id))).ok) refresh();
                          }}>Marcar como lida</Button>
                        ) : null}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
            <Pagination page={data.page} pageCount={Math.max(1, Math.ceil(data.total / data.perPage))} onPage={setPage} />
          </Card>
          <p className="text-muted" style={{ fontSize: "var(--fs-sm)" }} data-testid="retention">{data.retentionPolicy}</p>
        </>
      )}</ResourceState>
    </div>
  );
}
