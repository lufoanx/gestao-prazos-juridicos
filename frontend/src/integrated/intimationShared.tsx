"use client";
// Contexto comum das telas de intimações e notificações (6.4). Reaproveita o contexto de prazos
// (ambiente, vínculo, nomes autorizados) — sem duplicar a lógica de nomes/membros.
import { useMemo } from "react";
import { Badge } from "@/components/ui";
import { createIntimationsClient, createNotificationsClient } from "@/lib/integration/intimations-client.mjs";
import type { IntimationStatus } from "@/lib/integration/dto.d.mts";
import { useAuth } from "./AuthProvider";
import { useDeadlineContext } from "./deadlineShared";

export const INTIMATION_STATUS_LABEL: Record<IntimationStatus, string> = {
  processing: "Em processamento", awaiting_review: "Aguardando revisão", failed: "Falha no processamento",
  reviewed: "Revisada", discarded: "Descartada",
};
const TONE = { processing: "info", awaiting_review: "warning", failed: "danger", reviewed: "success", discarded: "neutral" } as const;

export function IntimationStatusBadge({ status }: { status: IntimationStatus }) {
  return <Badge tone={TONE[status]}>{INTIMATION_STATUS_LABEL[status]}</Badge>;
}

export function useIntimationContext() {
  const base = useDeadlineContext();
  const { api } = useAuth();
  const intimations = useMemo(() => createIntimationsClient(api), [api]);
  const notifications = useMemo(() => createNotificationsClient(api), [api]);
  return { ...base, intimations, notifications };
}

/** Aviso permanente: só metadados; sem envio/armazenamento; sem processamento/OCR/IA. */
export function MetadataOnlyNotice() {
  return (
    <div className="form-note" role="note" style={{ margin: "8px 0 16px" }}>
      <span>
        O arquivo PDF <strong>não é enviado nem armazenado</strong>: registramos apenas os metadados que você
        declara (nome, tamanho, tipo e data de recebimento). Processamento, OCR e IA estão indisponíveis; os dados do
        prazo são preenchidos e revisados manualmente por você.
      </span>
    </div>
  );
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** Evento de página para atualizar o contador de não lidas após ações relevantes (só nesta aba). */
export const NOTIFICATIONS_CHANGED = "prazoai:notifications-changed";
export function announceNotificationsChanged() {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(NOTIFICATIONS_CHANGED));
}
