import type { ReactNode } from "react";
import { NoticePage } from "@/integrated/Unavailable";
import { APP_MODE } from "@/lib/integration/mode.mjs";

// Modo integrado (6.1): este fluxo pertence a uma próxima entrega. As telas demonstrativas
// nunca são renderizadas (defesa além da reescrita do middleware).
export default function PendingFlowLayout({ children }: { children: ReactNode }) {
  if (APP_MODE !== "integrated") return children;
  return (
    <NoticePage title="Ainda não integrado">
      Este fluxo será conectado ao servidor em uma próxima entrega. Nenhum dado demonstrativo é usado aqui.
    </NoticePage>
  );
}
