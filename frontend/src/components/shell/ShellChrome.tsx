"use client";
import type { ReactNode } from "react";
import { useSettings } from "@/context/SettingsContext";

/** Aplica preferências de exibição (efeito real) como classes na casca. */
export function ShellChrome({ children }: { children: ReactNode }) {
  const { settings } = useSettings();
  const cls = [
    "app-shell",
    settings.density === "compact" ? "is-compact" : "",
    settings.reduceMotion ? "is-reduce-motion" : "",
  ].filter(Boolean).join(" ");
  return <div className={cls}>{children}</div>;
}
