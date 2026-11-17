import type { Metadata } from "next";
import type { ReactNode } from "react";
import { IntegratedResetPassword } from "@/integrated/RecoveryScreens";
import { APP_MODE } from "@/lib/integration/mode.mjs";

// /redefinir-senha#TOKEN (E5). O token vem SÓ do fragmento, capturado no cliente e removido da
// barra; trafega apenas no corpo do POST ao BFF. Sem segmento de token no caminho: o formato antigo
// /redefinir-senha/<token> é reescrito pelo middleware para uma página estática.
export const metadata: Metadata = { referrer: "no-referrer" };

export default function ResetPasswordLayout({ children }: { children: ReactNode }) {
  return APP_MODE === "integrated" ? <IntegratedResetPassword /> : children;
}
