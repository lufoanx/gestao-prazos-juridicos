// BFF (Etapa 6.2): consulta PÚBLICA de convite. Rota explícita (não é o proxy autenticado).
// O token trafega só no corpo; a resposta não altera cookies; sem cache.
import { runBff } from "@/server/bff/instance.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function POST(request: Request) {
  return runBff((bff) => bff.publicInvitationLookup(request));
}
