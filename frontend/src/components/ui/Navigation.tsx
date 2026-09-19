"use client";
import { useRef, type ReactNode } from "react";

/* ---------- Tabs ---------- */
export interface TabItem { id: string; label: string; }
export function Tabs({
  items, active, onChange, ariaLabel = "Abas",
}: { items: TabItem[]; active: string; onChange: (id: string) => void; ariaLabel?: string }) {
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});

  function onKey(e: React.KeyboardEvent) {
    const idx = items.findIndex((t) => t.id === active);
    if (idx < 0) return;
    let next = idx;
    if (e.key === "ArrowRight") next = (idx + 1) % items.length;
    else if (e.key === "ArrowLeft") next = (idx - 1 + items.length) % items.length;
    else return;
    e.preventDefault();
    const id = items[next].id;
    onChange(id);
    refs.current[id]?.focus();
  }

  return (
    <div className="tabs" role="tablist" aria-label={ariaLabel} onKeyDown={onKey}>
      {items.map((t) => (
        <button
          key={t.id}
          ref={(el) => { refs.current[t.id] = el; }}
          className="tabs__tab"
          role="tab"
          aria-selected={t.id === active}
          tabIndex={t.id === active ? 0 : -1}
          onClick={() => onChange(t.id)}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

/* ---------- Pagination ---------- */
export function Pagination({
  page, pageCount, onPage, info,
}: { page: number; pageCount: number; onPage: (p: number) => void; info?: ReactNode }) {
  if (pageCount <= 1 && !info) return null;
  const pages = Array.from({ length: pageCount }, (_, i) => i + 1);
  return (
    <div className="pagination">
      {info ? <span className="pagination__info">{info}</span> : null}
      <button
        className="pagination__btn" onClick={() => onPage(page - 1)}
        disabled={page <= 1} aria-label="Página anterior"
      >‹</button>
      {pages.map((p) => (
        <button
          key={p} className="pagination__btn"
          aria-current={p === page ? "true" : undefined}
          aria-label={`Página ${p}`}
          onClick={() => onPage(p)}
        >{p}</button>
      ))}
      <button
        className="pagination__btn" onClick={() => onPage(page + 1)}
        disabled={page >= pageCount} aria-label="Próxima página"
      >›</button>
    </div>
  );
}
