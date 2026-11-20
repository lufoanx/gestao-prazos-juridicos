"use client";
// Portão das áreas do escritório no modo integrado (doc 26). Em vez de um aviso sem saída:
// - sem vínculo → caminhos EXISTENTES para criar escritório ou solicitar ingresso;
// - com vínculo e ambiente pessoal selecionado → troca EXPLÍCITA de ambiente (nada é transferido);
// - vínculo carregando/indisponível → estado visível, nunca "sem escritório" por engano.
// É só interface: o servidor continua decidindo permissões e vínculo.
import type { ReactNode } from "react";
import Link from "next/link";
import { Button } from "@/components/ui";
import { OFFICE_ENTRY_TEXT as T, officeEntryState } from "@/lib/office-entry.mjs";
import { useOrg } from "./OrgProvider";
import { Card, Notice, PageHead } from "./ui";

export function OfficeGate({ title, children }: { title: string; children: (officeId: string) => ReactNode }) {
  const { state, controller } = useOrg();
  const entry = officeEntryState({ status: state.status, hasOffice: Boolean(state.office), scope: state.scope });

  if (entry === "loading") return <p aria-busy="true">Carregando…</p>;
  if (entry === "error") {
    // O aviso com "Tentar novamente" fica na casca (IntegratedShell); aqui só não se finge carregar.
    return <><PageHead title={title} /><p className="text-muted">{T.waiting}</p></>;
  }
  if (entry === "no-office") {
    return (
      <>
        <PageHead title={title} />
        <Card>
          <p><strong>{T.noOffice}</strong></p>
          <p className="text-muted">{T.noOfficeHow}</p>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, margin: "12px 0" }}>
            <Link className="btn btn--primary" href="/onboarding">{T.createAction}</Link>
            <Link className="btn btn--secondary" href="/solicitar-ingresso">{T.joinAction}</Link>
          </div>
          <p className="text-muted">{T.inviteHint}</p>
        </Card>
      </>
    );
  }
  if (entry === "personal") {
    return (
      <>
        <PageHead title={title} />
        <Notice>{T.personal} {T.personalHow}</Notice>
        <Button onClick={() => controller.selectScope("office")}>{T.openOfficeAction}</Button>
      </>
    );
  }
  return <>{children(state.office!.id)}</>;
}
