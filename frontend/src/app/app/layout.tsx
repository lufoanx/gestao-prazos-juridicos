import type { ReactNode } from "react";
import { AppShell } from "@/components/shell/AppShell";
import { IntegratedShell } from "@/integrated/IntegratedShell";
import { APP_MODE } from "@/lib/integration/mode.mjs";

// Casca compartilhada de todas as telas do produto (área /app).
// Modo integrado (Etapa 6.1): casca própria, sem provedores de dados demonstrativos.
export default function AppLayout({ children }: { children: ReactNode }) {
  return APP_MODE === "integrated" ? <IntegratedShell>{children}</IntegratedShell> : <AppShell>{children}</AppShell>;
}
