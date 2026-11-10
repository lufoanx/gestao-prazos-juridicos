"use client";
// Moldura das telas integradas fora de /app (onboarding, convite, solicitação).
import Link from "next/link";
import type { ReactNode } from "react";

export function PublicFrame({ title, subtitle, children }: { title: string; subtitle?: string; children: ReactNode }) {
  return (
    <main className="auth" id="conteudo">
      <div className="card" style={{ maxWidth: 640, margin: "48px auto" }}>
        <div className="card__body">
          <h1 style={{ fontSize: "var(--fs-xl)", margin: "0 0 4px" }}>{title}</h1>
          {subtitle ? <p className="text-muted" style={{ marginTop: 0 }}>{subtitle}</p> : null}
          {children}
          <p style={{ marginTop: 24 }}><Link href="/app">Ir para o painel</Link></p>
        </div>
      </div>
    </main>
  );
}
