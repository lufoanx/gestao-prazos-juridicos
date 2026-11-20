"use client";
// MODO DEMO (dados fictícios no navegador): estado vazio das áreas do escritório (doc 26).
// Sem escritório → caminhos já existentes do onboarding demonstrativo; com escritório e ambiente
// pessoal → troca explícita de ambiente. Mesma decisão do modo integrado (src/lib/office-entry.mjs).
import type { ReactNode } from "react";
import Link from "next/link";
import { Building2 } from "lucide-react";
import { EmptyState } from "@/components/ui";
import { useScope } from "@/context/ScopeContext";
import { OFFICE_ENTRY_TEXT as T, officeEntryState } from "@/lib/office-entry.mjs";

export function DemoOfficeEntry({ title, icon }: { title: string; icon?: ReactNode }) {
  const { hasOffice, scopeKind, setScopeKind } = useScope();
  const entry = officeEntryState({ hasOffice, scope: scopeKind });
  return (
    <div>
      <div className="page-head"><div className="page-head__title">
        <h1 style={{ fontSize: "var(--fs-2xl)", fontWeight: 700, color: "var(--text-strong)", margin: 0 }}>{title}</h1>
      </div></div>
      <div className="card"><div className="card__body">
        {entry === "no-office" ? (
          <EmptyState icon={icon ?? <Building2 size={30} aria-hidden />} title={T.noOffice}>
            <span style={{ display: "block" }}>{T.noOfficeHow}</span>
            <span style={{ display: "flex", flexWrap: "wrap", gap: 8, justifyContent: "center", marginTop: 12 }}>
              <Link className="btn btn--primary" href="/onboarding/escritorio">{T.createAction}</Link>
              <Link className="btn btn--secondary" href="/solicitar-ingresso">{T.joinAction}</Link>
            </span>
          </EmptyState>
        ) : (
          <EmptyState icon={icon ?? <Building2 size={30} aria-hidden />} title={T.personal}>
            <span style={{ display: "block" }}>{T.personalHow}</span>
            <span style={{ display: "flex", justifyContent: "center", marginTop: 12 }}>
              <button type="button" className="btn btn--primary" onClick={() => setScopeKind("office")}>{T.openOfficeAction}</button>
            </span>
          </EmptyState>
        )}
      </div></div>
    </div>
  );
}
