"use client";
import { usePathname } from "next/navigation";
import { Logo } from "@/components/brand/Logo";
import { ScopeSwitcher } from "./ScopeSwitcher";
import { navSections } from "./nav";
import { useScope } from "@/context/ScopeContext";

function NavContent() {
  const pathname = usePathname();
  const { hasOffice, membership, scopeKind } = useScope();
  const perms = membership?.permissions ?? [];

  return (
    <>
      {navSections.map((section, i) => {
        // Gestão de escritório: apenas no ambiente de escritório e com vínculo.
        if (section.scope === "office" && (!hasOffice || scopeKind !== "office")) return null;
        // Cada item de escritório exige a permissão correspondente.
        const items = section.items.filter((it) => !it.requires || perms.includes(it.requires));
        if (items.length === 0) return null;
        return (
          <div className="app-nav__section-wrap" key={i}>
            {section.title ? <div className="app-nav__section">{section.title}</div> : null}
            {items.map((item) => {
              const active = pathname === item.href || pathname.startsWith(item.href + "/");
              const Icon = item.icon;
              return (
                <a
                  key={item.href} href={item.href} className="app-nav__link"
                  aria-current={active ? "page" : undefined}
                >
                  <Icon size={17} aria-hidden /> {item.label}
                </a>
              );
            })}
          </div>
        );
      })}
    </>
  );
}

export function Sidebar() {
  return (
    <aside className="app-sidebar">
      <div className="app-sidebar__brand">
        <Logo height={46} onDark />
      </div>
      <div className="app-sidebar__scope">
        <ScopeSwitcher />
      </div>
      <nav className="app-nav" aria-label="Navegação principal">
        <NavContent />
      </nav>
      <div className="app-sidebar__foot">
        Ambiente demonstrativo · dados fictícios
      </div>
    </aside>
  );
}

/** Conteúdo de navegação reutilizado no drawer móvel. */
export function SidebarNav() {
  return (
    <nav className="app-nav" aria-label="Navegação principal" style={{ paddingTop: 8 }}>
      <NavContent />
    </nav>
  );
}
