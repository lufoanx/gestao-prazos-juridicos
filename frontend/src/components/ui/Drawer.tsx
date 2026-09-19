"use client";
import { useEffect, useRef, type ReactNode } from "react";
import { X } from "lucide-react";

interface DrawerProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  side?: "left" | "right";
  navy?: boolean;
  children: ReactNode;
  ariaLabel?: string;
}

export function Drawer({
  open, onClose, title, side = "left", navy, children, ariaLabel,
}: DrawerProps) {
  const ref = useRef<HTMLDivElement>(null);
  const restoreTo = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    restoreTo.current = document.activeElement as HTMLElement;
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") onClose(); }
    document.addEventListener("keydown", onKey);
    const t = setTimeout(() => ref.current?.focus(), 0);
    return () => {
      document.removeEventListener("keydown", onKey);
      clearTimeout(t);
      restoreTo.current?.focus?.();
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <>
      <div className="drawer-overlay" onClick={onClose} aria-hidden />
      <div
        className={`drawer drawer--${side}${navy ? " drawer--navy" : ""}`}
        role="dialog" aria-modal="true" aria-label={ariaLabel ?? title}
        ref={ref} tabIndex={-1}
      >
        {title ? (
          <div className="drawer__head">
            <strong>{title}</strong>
            <button className="modal__close" onClick={onClose} aria-label="Fechar"><X size={18} aria-hidden /></button>
          </div>
        ) : null}
        <div className="drawer__body">{children}</div>
      </div>
    </>
  );
}
