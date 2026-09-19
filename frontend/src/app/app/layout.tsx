import type { ReactNode } from "react";
import { AppShell } from "@/components/shell/AppShell";

// Casca compartilhada de todas as telas do produto (área /app).
export default function AppLayout({ children }: { children: ReactNode }) {
  return <AppShell>{children}</AppShell>;
}
