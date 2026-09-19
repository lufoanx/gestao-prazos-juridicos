"use client";
import { useState } from "react";
import { ChevronDown } from "lucide-react";

export interface QA { q: string; a: string; }

export function Faq({ items }: { items: QA[] }) {
  const [open, setOpen] = useState<number | null>(0);
  return (
    <div className="faq">
      {items.map((it, i) => {
        const isOpen = open === i;
        const panelId = `faq-panel-${i}`;
        const btnId = `faq-btn-${i}`;
        return (
          <div className="faq__item" key={i}>
            <h3 style={{ margin: 0 }}>
              <button
                id={btnId} className="faq__q" aria-expanded={isOpen} aria-controls={panelId}
                onClick={() => setOpen(isOpen ? null : i)}
              >
                {it.q}
                <ChevronDown size={18} aria-hidden style={{ transform: isOpen ? "rotate(180deg)" : "none", transition: "transform .15s ease", flex: "none" }} />
              </button>
            </h3>
            {isOpen ? <div className="faq__a" id={panelId} role="region" aria-labelledby={btnId}>{it.a}</div> : null}
          </div>
        );
      })}
    </div>
  );
}
