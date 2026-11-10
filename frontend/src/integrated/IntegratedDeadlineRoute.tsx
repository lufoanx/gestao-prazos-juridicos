"use client";
// Rotas dinâmicas /app/prazos/[id] e /app/prazos/[id]/editar no modo integrado.
import { useParams } from "next/navigation";
import { IntegratedDeadlineDetail } from "./IntegratedDeadlineDetail";

export function IntegratedDeadlineRoute({ editing = false }: { editing?: boolean }) {
  const params = useParams<{ id: string }>();
  return <IntegratedDeadlineDetail deadlineId={String(params?.id ?? "")} startEditing={editing} />;
}

export function IntegratedDeadlineEditRoute() {
  return <IntegratedDeadlineRoute editing />;
}
