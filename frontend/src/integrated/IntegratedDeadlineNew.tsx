"use client";
// Cadastro manual integrado (6.3). Sem reenvio automático: resultado desconhecido pede conferência.
import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui";
import { selectableResponsibles } from "@/lib/integration/deadline-caps.mjs";
import { DeadlineFields, draftToInput, emptyDraft, validateDraft, type DeadlineDraft } from "./DeadlineFields";
import { ScopeGate, useDeadlineContext } from "./deadlineShared";
import { Card, Notice, PageHead, useMutation } from "./ui";

export function IntegratedDeadlineNew() {
  return <ScopeGate><NewView /></ScopeGate>;
}

function NewView() {
  const router = useRouter();
  const { client, scope, caps, me, org, members } = useDeadlineContext();
  const responsibles = selectableResponsibles(scope, org.membership, members.status === "ready" ? members.data.members : [], me!);
  const [draft, setDraft] = useState<DeadlineDraft>(() => emptyDraft(me!.id));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [unknown, setUnknown] = useState(false);
  const m = useMutation();

  if (!caps.canCreate) {
    return <><PageHead title="Novo prazo" /><Notice>Você não tem permissão para criar prazos neste ambiente.</Notice></>;
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const errs = validateDraft(draft);
    setErrors(errs);
    if (Object.keys(errs).length) return;
    setUnknown(false);
    const r = await m.run(() => client.create(scope, draftToInput(draft)));
    if (r.ok) router.push(`/app/prazos/${r.value.id}`);
    else if (r.unknownOutcome) setUnknown(true);
  }

  return (
    <div>
      <PageHead title="Novo prazo" />
      <Card title={scope === "office" ? `Ambiente do escritório: ${org.office?.name ?? ""}` : "Ambiente pessoal"}>
        <form onSubmit={submit} noValidate aria-label="Novo prazo">
          <DeadlineFields draft={draft} onChange={setDraft} errors={errors} responsibles={responsibles} lockResponsible={responsibles.length <= 1} />
          {m.error ? <Notice kind="error">{m.error}</Notice> : null}
          {unknown ? <p><Link href="/app/prazos">Conferir a lista de prazos</Link> antes de enviar de novo.</p> : null}
          <Button type="submit" disabled={m.busy}>{m.busy ? "Salvando…" : "Salvar prazo"}</Button>
        </form>
      </Card>
    </div>
  );
}
