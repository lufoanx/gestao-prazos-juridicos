"use client";
import { useEffect, useRef, useCallback, type ReactNode } from "react";
import { X } from "lucide-react";
import { Button } from "./Primitives";

const FOCUSABLE = 'a[href],button:not([disabled]),textarea,input,select,[tabindex]:not([tabindex="-1"])';

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children?: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
  labelledById?: string;
}

export function Modal({ open, onClose, title, children, footer, wide }: ModalProps) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useRef(`modal-${Math.random().toString(36).slice(2)}`).current;
  const restoreTo = useRef<HTMLElement | null>(null);

  const onKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === "Escape") { e.preventDefault(); onClose(); return; }
    if (e.key !== "Tab") return;
    const root = ref.current;
    if (!root) return;
    const nodes = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE))
      .filter((n) => n.offsetParent !== null || n === document.activeElement);
    if (nodes.length === 0) return;
    const first = nodes[0]; const last = nodes[nodes.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }, [onClose]);

  useEffect(() => {
    if (!open) return;
    restoreTo.current = document.activeElement as HTMLElement;
    document.addEventListener("keydown", onKeyDown);
    const t = setTimeout(() => {
      const root = ref.current;
      const target = root?.querySelector<HTMLElement>(FOCUSABLE) ?? root;
      target?.focus();
    }, 0);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = prevOverflow;
      clearTimeout(t);
      restoreTo.current?.focus?.();
    };
  }, [open, onKeyDown]);

  if (!open) return null;

  return (
    <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div
        className={`modal${wide ? " modal--wide" : ""}`}
        role="dialog" aria-modal="true" aria-labelledby={titleId}
        ref={ref} tabIndex={-1}
      >
        <div className="modal__head">
          <h2 className="modal__title" id={titleId}>{title}</h2>
          <button className="modal__close" onClick={onClose} aria-label="Fechar"><X size={18} aria-hidden /></button>
        </div>
        {children != null ? <div className="modal__body">{children}</div> : null}
        {footer ? <div className="modal__foot">{footer}</div> : null}
      </div>
    </div>
  );
}

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}
export function ConfirmDialog({
  open, title, message, confirmLabel = "Confirmar", cancelLabel = "Cancelar",
  danger, onConfirm, onCancel,
}: ConfirmDialogProps) {
  return (
    <Modal open={open} onClose={onCancel} title={title} footer={
      <>
        <Button variant="secondary" onClick={onCancel}>{cancelLabel}</Button>
        <Button variant={danger ? "danger" : "primary"} onClick={onConfirm}>{confirmLabel}</Button>
      </>
    }>
      {message}
    </Modal>
  );
}
