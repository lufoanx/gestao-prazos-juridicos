import type { ReactNode } from "react";
import { IntegratedInvite } from "@/integrated/IntegratedInvite";
import { APP_MODE } from "@/lib/integration/mode.mjs";

// Modo integrado (6.2): convite pelo fragmento (/convite#TOKEN). O formato antigo
// (/convite/<token>) é reescrito pelo middleware para /convite-antigo, sem chamar a API.
export default function ConviteLayout({ children }: { children: ReactNode }) {
  return APP_MODE === "integrated" ? <IntegratedInvite /> : children;
}
