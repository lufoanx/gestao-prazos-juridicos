import type { ReactNode } from "react";
import { NoticePage } from "@/integrated/Unavailable";
import { APP_MODE } from "@/lib/integration/mode.mjs";

// Modo integrado (6.1): a recuperação de senha depende do envio de e-mail, que ainda não existe.
export default function UnavailableFlowLayout({ children }: { children: ReactNode }) {
  if (APP_MODE !== "integrated") return children;
  return (
    <NoticePage title="Indisponível nesta fase">
      A recuperação de senha depende do envio de e-mail, que ainda não existe. Nenhum e-mail é enviado.
    </NoticePage>
  );
}
