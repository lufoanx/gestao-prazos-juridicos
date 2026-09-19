import type { ReactNode } from "react";
import Link from "next/link";
import { Logo } from "@/components/brand/Logo";

export function OnboardingShell({
  title, subtitle, children, wide,
}: { title: string; subtitle?: ReactNode; children: ReactNode; wide?: boolean }) {
  return (
    <main className="onb" id="conteudo">
      <div className="onb__inner">
        <div className="onb__head">
          <div className="onb__logo">
            <Link href="/" aria-label="PrazoAI — início"><Logo height={40} /></Link>
          </div>
          <h1 className="onb__title">{title}</h1>
          {subtitle ? <p className="onb__sub">{subtitle}</p> : null}
        </div>
        {wide ? children : <div className="onb__card">{children}</div>}
      </div>
    </main>
  );
}
