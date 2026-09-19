"use client";
import { useState } from "react";
import Link from "next/link";
import { Menu, X } from "lucide-react";
import { Logo } from "@/components/brand/Logo";

const LINKS = [
  { href: "#recursos", label: "Recursos" },
  { href: "#como-funciona", label: "Como funciona" },
  { href: "#para-quem", label: "Para quem é" },
  { href: "#faq", label: "Perguntas" },
];

export function PublicNav() {
  const [open, setOpen] = useState(false);
  return (
    <header className="lp-header">
      <div className="lp-header__inner">
        <Link href="/" aria-label="PrazoAI — início"><Logo height={34} /></Link>
        <nav className={`lp-nav${open ? " lp-nav--open" : ""}`} aria-label="Seções">
          {LINKS.map((l) => (
            <a key={l.href} href={l.href} onClick={() => setOpen(false)}>{l.label}</a>
          ))}
        </nav>
        <div className="lp-header__actions">
          <Link className="btn btn--ghost btn--sm" href="/login">Entrar</Link>
          <Link className="btn btn--primary btn--sm" href="/cadastro">Criar conta</Link>
          <button
            className="icon-btn lp-burger" aria-expanded={open}
            aria-label={open ? "Fechar menu" : "Abrir menu"}
            onClick={() => setOpen((o) => !o)}
          >
            {open ? <X size={20} aria-hidden /> : <Menu size={20} aria-hidden />}
          </button>
        </div>
      </div>
    </header>
  );
}
