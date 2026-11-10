"use client";
// Registro de intimação (6.4): SOMENTE metadados declarados. Se a pessoa escolher um arquivo, só
// nome, tamanho e tipo informados pelo navegador são usados — o conteúdo NÃO é lido nem enviado.
import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button, Input, Select } from "@/components/ui";
import { canRegisterIntimation } from "@/lib/integration/intimation-caps.mjs";
import { selectableResponsibles } from "@/lib/integration/deadline-caps.mjs";
import { isCivilDate } from "@/lib/integration/civil-date.mjs";
import { ScopeGate } from "./deadlineShared";
import { MetadataOnlyNotice, formatBytes, useIntimationContext } from "./intimationShared";
import { Card, Notice, PageHead, useMutation } from "./ui";

const MAX_BYTES = 10 * 1024 * 1024;

export function IntegratedIntimationRegister() {
  return <ScopeGate><RegisterView /></ScopeGate>;
}

function RegisterView() {
  const router = useRouter();
  const { intimations, scope, org, members, me } = useIntimationContext();
  const [fileName, setFileName] = useState("");
  const [sizeKb, setSizeKb] = useState("");
  const [receivedAt, setReceivedAt] = useState("");
  const [suggested, setSuggested] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [unknown, setUnknown] = useState(false);
  const m = useMutation();

  if (!canRegisterIntimation(scope, org.membership)) {
    return <><PageHead title="Registrar intimação" /><Notice>Você não tem permissão para registrar intimações neste ambiente.</Notice></>;
  }
  const candidates = scope === "office" ? selectableResponsibles("office", org.membership, members.status === "ready" ? members.data.members : [], me!) : [];

  function pickFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    setFileName(f.name);                                // só metadados do navegador
    setSizeKb(String(Math.max(1, Math.ceil(f.size / 1024))));
    e.target.value = "";                                // nada fica retido; o conteúdo nunca é lido
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const errs: Record<string, string> = {};
    const name = fileName.trim();
    const bytes = Math.round(Number(sizeKb) * 1024);
    if (!name || name.length > 255 || /[\\/]/.test(name) || !name.toLowerCase().endsWith(".pdf")) errs.fileName = "Informe o nome de um arquivo .pdf (sem barras).";
    if (!/^\d+(\.\d+)?$/.test(sizeKb) || bytes < 1 || bytes > MAX_BYTES) errs.sizeKb = "Tamanho declarado entre 1 KB e 10 MB.";
    if (!isCivilDate(receivedAt)) errs.receivedAt = "Informe a data de recebimento.";
    setErrors(errs);
    if (Object.keys(errs).length) return;
    setUnknown(false);
    const r = await m.run(() => intimations.register(scope, {
      fileName: name, sizeBytes: bytes, contentType: "application/pdf", receivedAt,
      ...(suggested ? { suggestedResponsibleId: suggested } : {}),
    }));
    if (r.ok) router.push(`/app/intimacoes/${r.value.id}`);
    else if (r.unknownOutcome) setUnknown(true);
  }

  return (
    <div>
      <PageHead title="Registrar intimação" />
      <MetadataOnlyNotice />
      <Card title={scope === "office" ? `Ambiente do escritório: ${org.office?.name ?? ""}` : "Ambiente pessoal"}>
        <form onSubmit={submit} noValidate aria-label="Registrar intimação">
          <label className="field__label" htmlFor="pick">Preencher a partir de um arquivo local (opcional)</label>
          <input id="pick" type="file" accept="application/pdf,.pdf" onChange={pickFile} />
          <p className="text-muted" style={{ fontSize: "var(--fs-sm)" }}>
            O arquivo não sai do seu computador: usamos apenas o nome e o tamanho informados pelo navegador.
          </p>
          <Input label="Nome do arquivo (.pdf)" required value={fileName} error={errors.fileName} onChange={(e) => setFileName(e.target.value)} />
          <Input label="Tamanho declarado (KB)" inputMode="decimal" required value={sizeKb} error={errors.sizeKb}
            hint={sizeKb && Number(sizeKb) > 0 ? formatBytes(Math.round(Number(sizeKb) * 1024)) : undefined} onChange={(e) => setSizeKb(e.target.value)} />
          <Input label="Recebida em" type="date" required value={receivedAt} error={errors.receivedAt} onChange={(e) => setReceivedAt(e.target.value)} />
          {scope === "office" ? (
            <Select label="Responsável sugerido (opcional)" value={suggested} onChange={(e) => setSuggested(e.target.value)}>
              <option value="">Nenhum</option>
              {candidates.map((c) => <option key={c.userId} value={c.userId}>{c.name}</option>)}
            </Select>
          ) : null}
          {m.error ? <Notice kind="error">{m.error}</Notice> : null}
          {unknown ? <p><Link href="/app/intimacoes">Conferir a lista de intimações</Link> antes de registrar de novo.</p> : null}
          <Button type="submit" disabled={m.busy}>{m.busy ? "Registrando…" : "Registrar metadados"}</Button>
        </form>
      </Card>
    </div>
  );
}
