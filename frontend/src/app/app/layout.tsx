import type { ReactNode } from "react";
import { AppShell } from "@/components/shell/AppShell";

// Casca compartilhada das telas do produto. Nesta etapa cobre o Dashboard;
// as demais telas /app/* migram para cá nas próximas etapas.
export default function AppLayout({ children }: { children: ReactNode }) {
  return <AppShell>{children}</AppShell>;
}
