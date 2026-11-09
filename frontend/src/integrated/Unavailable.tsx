import { Info } from "lucide-react";
import Link from "next/link";

/** Recurso inexistente nesta fase: desabilitado, com explicação (nunca simulado). */
export function UnavailableNote({ feature, reason }: { feature: string; reason: string }) {
  return (
    <button type="button" className="google-btn" disabled aria-disabled="true" title={reason}>
      <Info size={16} aria-hidden /> {feature} — indisponível nesta fase
    </button>
  );
}

export function NoticePage({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <main className="auth" id="conteudo">
      <div className="card" style={{ maxWidth: 560, margin: "64px auto" }}>
        <div className="card__body">
          <h1 style={{ fontSize: "var(--fs-xl)", margin: "0 0 12px" }}>{title}</h1>
          <div className="text-muted">{children}</div>
          <p style={{ marginTop: 16 }}><Link href="/app">Voltar</Link></p>
        </div>
      </div>
    </main>
  );
}
