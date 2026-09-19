"use client";
import { User, Building2 } from "lucide-react";
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
        title={hasOffice ? undefined : "Você ainda não participa de um escritório"}
      >
        <Building2 size={15} aria-hidden /> Escritório
      </button>
    </div>
  );
}
