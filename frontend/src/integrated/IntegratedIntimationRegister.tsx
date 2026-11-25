"use client";
// Registro de intimação com PDF (doc 28): 1) registra os metadados (nome e tamanho do arquivo escolhido,
// data de recebimento); 2) envia o PDF pela rota binária do BFF. O conteúdo NÃO é lido automaticamente:
// os dados do prazo são preenchidos à mão na revisão. Se o envio falhar, a intimação fica registrada sem
// PDF (indicado na tela) e o envio pode ser repetido no detalhe — nunca há "sucesso" sem arquivo.
import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button, Input, Select } from "@/components/ui";
import { canRegisterIntimation } from "@/lib/integration/intimation-caps.mjs";
import { selectableResponsibles } from "@/lib/integration/deadline-caps.mjs";
import { isCivilDate } from "@/lib/integration/civil-date.mjs";
import { ScopeGate } from "./deadlineShared";
import { ManualReviewNotice, formatBytes, localPdfProblem, useIntimationContext } from "./intimationShared";
import { Card, Notice, PageHead, useMutation } from "./ui";

export function IntegratedIntimationRegister() {
  return <ScopeGate><RegisterView /></ScopeGate>;
}

function RegisterView() {
  const router = useRouter();
  const { intimations, scope, org, members, me } = useIntimationContext();
  const [file, setFile] = useState<File | null>(null);
  const [receivedAt, setReceivedAt] = useState("");
  const [suggested, setSuggested] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [unknown, setUnknown] = useState(false);
  const [registeredId, setRegisteredId] = useState<string | null>(null);
  const m = useMutation();

  if (!canRegisterIntimation(scope, org.membership)) {
    return <><PageHead title="Enviar intimação (PDF)" /><Notice>Você não tem permissão para registrar intimações neste ambiente.</Notice></>;
  }
  const candidates = scope === "office" ? selectableResponsibles("office", org.membership, members.status === "ready" ? members.data.members : [], me!) : [];

  function pickFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0] ?? null;
    setFile(f);
    setErrors((prev) => ({ ...prev, file: f ? (localPdfProblem(f) ?? "") : "" }));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const errs: Record<string, string> = {};
    if (!file) errs.file = "Selecione o PDF da intimação.";
    else if (localPdfProblem(file)) errs.file = localPdfProblem(file)!;
    if (!isCivilDate(receivedAt)) errs.receivedAt = "Informe a data de recebimento.";
    setErrors(errs);
    if (Object.values(errs).some(Boolean) || !file) return;
    setUnknown(false);
    // Etapa 1: registro (só metadados) — ou reaproveita o registro já feito numa tentativa anterior.
    let id = registeredId;
    if (!id) {
      const name = file.name.replace(/[\\/]/g, "_").slice(-255) || "intimacao.pdf";
      const r = await m.run(() => intimations.register(scope, {
        fileName: name.toLowerCase().endsWith(".pdf") ? name : `${name.slice(0, 251)}.pdf`,
        sizeBytes: file.size, contentType: "application/pdf", receivedAt,
        ...(suggested ? { suggestedResponsibleId: suggested } : {}),
      }));
      if (!r.ok) { if (r.unknownOutcome) setUnknown(true); return; }
      id = r.value.id;
      setRegisteredId(id);
    }
    // Etapa 2: envio do PDF.
    const up = await m.run(() => intimations.uploadFile(id!, file));
    if (up.ok) router.push(`/app/intimacoes/${id}`);
  }

  return (
    <div>
      <PageHead title="Enviar intimação (PDF)" />
      <ManualReviewNotice />
      <Card title={scope === "office" ? `Ambiente do escritório: ${org.office?.name ?? ""}` : "Ambiente pessoal"}>
        <form onSubmit={submit} noValidate aria-label="Enviar intimação">
          <label className="field__label" htmlFor="pdf">Arquivo PDF (até 10 MiB)</label>
          <input id="pdf" type="file" accept="application/pdf,.pdf" onChange={pickFile} disabled={!!registeredId} />
          {file ? <p className="text-muted" style={{ fontSize: "var(--fs-sm)" }} data-testid="picked">{file.name} · {formatBytes(file.size)}</p> : null}
          {errors.file ? <p className="field__error" role="alert">{errors.file}</p> : null}
          <Input label="Recebida em" type="date" required value={receivedAt} error={errors.receivedAt} disabled={!!registeredId}
            onChange={(e) => setReceivedAt(e.target.value)} />
          {scope === "office" ? (
            <Select label="Responsável sugerido (opcional)" value={suggested} disabled={!!registeredId} onChange={(e) => setSuggested(e.target.value)}>
              <option value="">Nenhum</option>
              {candidates.map((c) => <option key={c.userId} value={c.userId}>{c.name}</option>)}
            </Select>
          ) : null}
          {m.error ? <Notice kind="error">{m.error}</Notice> : null}
          {registeredId && m.error ? (
            <p data-testid="upload-pending">
              A intimação foi registrada, mas o PDF ainda <strong>não foi armazenado</strong>. Tente enviar de novo ou{" "}
              <Link href={`/app/intimacoes/${registeredId}`}>abra a intimação</Link> para enviar depois.
            </p>
          ) : null}
          {unknown ? <p><Link href="/app/intimacoes">Conferir a lista de intimações</Link> antes de registrar de novo.</p> : null}
          <Button type="submit" disabled={m.busy}>{m.busy ? "Enviando…" : registeredId ? "Enviar o PDF de novo" : "Registrar e enviar PDF"}</Button>
        </form>
      </Card>
    </div>
  );
}
