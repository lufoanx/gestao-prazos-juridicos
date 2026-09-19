"use client";
import { createContext, useContext, useState, useCallback, useRef, type ReactNode } from "react";
import { CheckCircle2, AlertCircle, Info, X } from "lucide-react";

type ToastKind = "success" | "error" | "info";
interface ToastItem { id: number; kind: ToastKind; title: string; message?: string; }

interface ToastApi {
  push: (t: { kind?: ToastKind; title: string; message?: string }) => void;
  success: (title: string, message?: string) => void;
  error: (title: string, message?: string) => void;
  info: (title: string, message?: string) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

const ICONS = { success: CheckCircle2, error: AlertCircle, info: Info } as const;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const seq = useRef(0);

  const remove = useCallback((id: number) => {
    setItems((cur) => cur.filter((t) => t.id !== id));
  }, []);

  const push = useCallback<ToastApi["push"]>(({ kind = "info", title, message }) => {
    const id = ++seq.current;
    setItems((cur) => [...cur, { id, kind, title, message }]);
    setTimeout(() => remove(id), 4500);
  }, [remove]);

  const api: ToastApi = {
    push,
    success: (title, message) => push({ kind: "success", title, message }),
    error: (title, message) => push({ kind: "error", title, message }),
    info: (title, message) => push({ kind: "info", title, message }),
  };

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="toast-region" role="region" aria-live="polite" aria-label="Notificações">
        {items.map((t) => {
          const Icon = ICONS[t.kind];
          return (
            <div key={t.id} className={`toast toast--${t.kind}`} role="status">
              <span className="toast__icon"><Icon size={18} aria-hidden /></span>
              <div className="toast__body">
                <div className="toast__title">{t.title}</div>
                {t.message ? <div>{t.message}</div> : null}
              </div>
              <button className="toast__close" onClick={() => remove(t.id)} aria-label="Fechar notificação">
                <X size={15} aria-hidden />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast deve ser usado dentro de <ToastProvider>");
  return ctx;
}
