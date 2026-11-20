"use client";
import { useId } from "react";
import Link from "next/link";
import { User, Building2 } from "lucide-react";
import { OFFICE_ENTRY_TEXT } from "@/lib/office-entry.mjs";
import { useScope } from "@/context/ScopeContext";
import { useToast } from "@/components/ui";

/**
 * Alternância Pessoal / Escritório. Muito visível por decisão de design.
 * Trocar o ambiente atualiza listas, contadores e notificações (o dashboard
 * re-deriva tudo a partir do escopo) e dispara um aviso de confirmação.
 */
export function ScopeSwitcher({ light = false }: { light?: boolean }) {
  const { scopeKind, setScopeKind, hasOffice, office } = useScope();
  const toast = useToast();
  const hintId = useId();

  function choose(kind: "personal" | "office") {
    if (kind === scopeKind) return;
    if (kind === "office" && !hasOffice) return;
    setScopeKind(kind);
    toast.info(
      kind === "personal" ? "Ambiente pessoal" : `Escritório · ${office?.name ?? ""}`,
      "Listas, contadores e notificações foram atualizados."
    );
  }

  return (
    <>
    <div
      className={`scope-switch${light ? " scope-switch--light" : ""}`}
      role="group" aria-label="Ambiente de trabalho"
    >
      <button
        type="button" className="scope-switch__btn"
        aria-pressed={scopeKind === "personal"}
        onClick={() => choose("personal")}
      >
        <User size={15} aria-hidden /> Pessoal
      </button>
      <button
        type="button" className="scope-switch__btn"
        aria-pressed={scopeKind === "office"}
        onClick={() => choose("office")}
        disabled={!hasOffice}
        aria-describedby={hasOffice ? undefined : hintId}
      >
        <Building2 size={15} aria-hidden /> Escritório
      </button>
    </div>
    {/* Sem vínculo, o motivo e o caminho ficam VISÍVEIS (antes: só um title, invisível ao toque). */}
    {!hasOffice ? (
      <p id={hintId} className={`scope-switch__hint${light ? " scope-switch__hint--light" : ""}`}>
        {OFFICE_ENTRY_TEXT.switchNoOffice} <Link href="/onboarding">{OFFICE_ENTRY_TEXT.switchNoOfficeAction}</Link>
      </p>
    ) : null}
    </>
  );
}
