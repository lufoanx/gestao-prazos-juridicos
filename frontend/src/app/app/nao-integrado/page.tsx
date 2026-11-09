import { NotIntegratedModule } from "@/integrated/IntegratedHome";

// Destino das rotas /app/* ainda não integradas (reescritas pelo middleware no modo integrado).
export default function NaoIntegradoPage() {
  return <NotIntegratedModule />;
}
