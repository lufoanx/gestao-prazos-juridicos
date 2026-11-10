import { OldInviteLink } from "@/integrated/IntegratedInvite";

// Destino da reescrita de /convite/<token> no modo integrado: o token do caminho é ignorado.
export default function ConviteAntigoPage() {
  return <OldInviteLink />;
}
