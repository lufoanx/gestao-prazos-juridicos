import { NoticePage } from "@/integrated/Unavailable";

// /convite (sem token no caminho). No modo integrado o layout renderiza o fluxo real;
// no modo demonstração, os convites usam o formato antigo do protótipo.
export default function ConvitePage() {
  return (
    <NoticePage title="Convite">
      Abra o link de convite completo que você recebeu.
    </NoticePage>
  );
}
