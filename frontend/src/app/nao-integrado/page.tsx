import { NoticePage } from "@/integrated/Unavailable";

// Fluxos públicos que pertencem às próximas entregas (onboarding, convites, solicitações).
export default function NaoIntegradoPublicPage() {
  return (
    <NoticePage title="Ainda não integrado">
      Este fluxo será conectado ao servidor em uma próxima entrega. Nenhum dado demonstrativo é usado aqui.
    </NoticePage>
  );
}
