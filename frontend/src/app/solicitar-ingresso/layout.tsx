import type { ReactNode } from "react";
import { IntegratedJoin } from "@/integrated/IntegratedJoin";
import { APP_MODE } from "@/lib/integration/mode.mjs";

// Modo integrado (6.2): solicitação de ingresso por código e acompanhamento das próprias.
export default function SolicitarIngressoLayout({ children }: { children: ReactNode }) {
  return APP_MODE === "integrated" ? <IntegratedJoin /> : children;
}
