import type { ReactNode } from "react";
import { IntegratedForgotPassword } from "@/integrated/RecoveryScreens";
import { APP_MODE } from "@/lib/integration/mode.mjs";

// Modo integrado (E5): pedido real pelo BFF (/bff/public/password/*), com consulta de
// disponibilidade e resposta neutra. Modo demonstração: a página simulada (nenhum e-mail sai).
export default function ForgotPasswordLayout({ children }: { children: ReactNode }) {
  return APP_MODE === "integrated" ? <IntegratedForgotPassword /> : children;
}
