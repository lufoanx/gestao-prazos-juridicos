"use client";
import Link from "next/link";
import { Compass } from "lucide-react";
import { EmptyState } from "@/components/ui";

export default function AppNotFound() {
  return (
    <div>
      <div className="page-head">
        <div className="page-head__title">
          <h1 style={{ fontSize: "var(--fs-2xl)", fontWeight: 700, color: "var(--text-strong)", margin: 0 }}>Página não encontrada</h1>
          <p className="page-head__subtitle">O endereço acessado não existe nesta área.</p>
        </div>
      </div>
      <div className="card"><div className="card__body">
        <EmptyState icon={<Compass size={30} aria-hidden />} title="Nada por aqui">
          Verifique o menu lateral ou volte ao painel.
        </EmptyState>
        <div style={{ textAlign: "center", marginTop: 12 }}>
          <Link className="btn btn--primary" href="/app/dashboard">Voltar ao dashboard</Link>
        </div>
      </div></div>
    </div>
  );
}
