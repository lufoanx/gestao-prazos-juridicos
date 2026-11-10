"use client";
// Peças comuns das telas integradas da 6.2 (mesma identidade visual do protótipo).
import { useCallback, useState, type ReactNode } from "react";
import { Button } from "@/components/ui";
import { useApiErrorHandler, type Resource } from "./useResource";
import { orgErrorMessage } from "./messages";

export function PageHead({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="page-head">
      <div className="page-head__title">
        <h1 style={{ fontSize: "var(--fs-2xl)", fontWeight: 700, margin: 0 }}>{title}</h1>
      </div>
      {children ? <div className="page-head__actions">{children}</div> : null}
    </div>
  );
}

export function Card({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <section className="card" style={{ marginBottom: 16 }}>
      <div className="card__body">
        {title ? <h2 style={{ fontSize: "var(--fs-lg)", margin: "0 0 12px" }}>{title}</h2> : null}
        {children}
      </div>
    </section>
  );
}

export function Notice({ kind = "info", children }: { kind?: "info" | "error" | "ok"; children: ReactNode }) {
  return (
    <p role={kind === "error" ? "alert" : "status"} className={kind === "error" ? "field__error" : "text-muted"}>
      {children}
    </p>
  );
}

/** Estados distintos de um recurso: carregando, sem acesso, erro/indisponível. */
export function ResourceState<T>({ res, children }: { res: Resource<T> & { reload: () => void }; children: (data: T) => ReactNode }) {
  if (res.status === "loading") return <p aria-busy="true">Carregando…</p>;
  if (res.status === "forbidden") return <Notice>{res.message}</Notice>;
  if (res.status === "error") {
    return (
      <div role="alert">
        <p className="field__error">{res.unavailable ? "Serviço indisponível no momento." : res.message}</p>
        <Button variant="secondary" size="sm" onClick={res.reload}>Tentar novamente</Button>
      </div>
    );
  }
  return <>{children(res.data)}</>;
}

export type MutationResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: string | null; message: string | null; unknownOutcome: boolean; error: unknown };

/** Resultado desconhecido: o servidor pode ter aplicado a mutação (timeout/rede após o envio). */
export function isUnknownOutcome(e: unknown): boolean {
  const cat = (e as { category?: string })?.category;
  return cat === "unknown_outcome" || cat === "network";
}

/** Mutação SEM repetição automática: um envio por clique; erro preservado com o formulário. */
export function useMutation() {
  const handle = useApiErrorHandler();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(async <T,>(fn: () => Promise<T>): Promise<MutationResult<T>> => {
    if (busy) return { ok: false, code: "busy", message: null, unknownOutcome: false, error: null };
    setBusy(true);
    setError(null);
    try {
      return { ok: true, value: await fn() };
    } catch (e) {
      const code = (e as { code?: string })?.code ?? null;
      const unknownOutcome = isUnknownOutcome(e);
      if (handle(e)) return { ok: false, code, message: null, unknownOutcome, error: e };
      const message = unknownOutcome
        ? "Não foi possível confirmar se a operação foi concluída: ela pode ter ocorrido. Confira antes de enviar de novo."
        : orgErrorMessage(e);
      setError(message);
      return { ok: false, code, message, unknownOutcome, error: e };
    } finally {
      setBusy(false);
    }
  }, [busy, handle]);
  return { busy, error, run, clear: () => setError(null), setError };
}

export function fmtDate(iso?: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
}

export const PERMISSION_LABELS: Record<string, string> = {
  "deadline.read": "Ver prazos",
  "deadline.create": "Criar prazos e comentar",
  "deadline.edit": "Editar prazos",
  "deadline.complete": "Concluir/reabrir prazos",
  "deadline.transfer": "Transferir prazos pessoais",
  "team.manage": "Gerir equipe",
  "office.manage": "Gerir escritório",
};
