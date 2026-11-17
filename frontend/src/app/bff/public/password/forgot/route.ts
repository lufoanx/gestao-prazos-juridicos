// BFF (E4, doc 21): recuperação de senha — rota PÚBLICA e explícita (não é o proxy autenticado).
// Destino fixo; sem sessão; não lê nem altera cookies; sem cache. Lógica em server/bff/public-recovery.mjs.
import { runBff } from "@/server/bff/instance.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function POST(request: Request) {
  return runBff((bff) => bff.passwordForgot(request));
}
