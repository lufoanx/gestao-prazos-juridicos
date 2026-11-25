"use client";
// Contexto comum das telas de intimações e notificações (6.4). Reaproveita o contexto de prazos
// (ambiente, vínculo, nomes autorizados) — sem duplicar a lógica de nomes/membros.
import { useMemo } from "react";
import { Badge, Button } from "@/components/ui";
import { createIntimationsClient, createNotificationsClient } from "@/lib/integration/intimations-client.mjs";
import type { IntimationStatus } from "@/lib/integration/dto.d.mts";
import { useAuth } from "./AuthProvider";
import { useDeadlineContext } from "./deadlineShared";
import { useMutation } from "./ui";

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

/** Aviso permanente (doc 28): o PDF é guardado, mas NÃO é lido automaticamente — preenchimento manual. */
export function ManualReviewNotice() {
  return (
    <div className="form-note" role="note" style={{ margin: "8px 0 16px" }}>
      <span>
        <strong>Preencha os dados do documento. Leitura automática ainda não disponível.</strong>{" "}
        O arquivo PDF fica em armazenamento privado e só pode ser baixado por quem tem acesso à intimação. A
        verificação confere apenas o formato do arquivo (não é antivírus). Os dados do prazo são preenchidos e
        revisados manualmente por você.
      </span>
    </div>
  );
}

export const PDF_MAX_BYTES = 10 * 1024 * 1024;

/** Verificação LOCAL só para orientar (o servidor valida o conteúdo de verdade). */
export function localPdfProblem(f: File): string | null {
  if (f.size === 0) return "O arquivo está vazio.";
  if (f.size > PDF_MAX_BYTES) return "O arquivo excede 10 MiB.";
  if (!(f.type === "application/pdf" || f.name.toLowerCase().endsWith(".pdf"))) return "Selecione um arquivo PDF.";
  return null;
}

/** Salva um Blob como download (URL temporária revogada logo depois). */
export function saveBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Botão "Baixar PDF" (download autenticado via BFF, com o cabeçalho anti-CSRF). */
export function DownloadPdfButton({ intimationId }: { intimationId: string }) {
  const { intimations } = useIntimationContext();
  const m = useMutation();
  async function go() {
    const r = await m.run(() => intimations.downloadFile(intimationId));
    if (r.ok) saveBlob(r.value.blob, r.value.fileName);
  }
  return (
    <span>
      <Button variant="secondary" onClick={go} disabled={m.busy}>{m.busy ? "Baixando…" : "Baixar PDF"}</Button>
      {m.error ? <span role="alert" className="field__error" style={{ marginLeft: 8 }}>{m.error}</span> : null}
    </span>
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
