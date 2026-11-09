// BFF (Etapa 6.1): estado da sessão para recarregamentos. Sem cache.
import { runBff } from "@/server/bff/instance.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(request: Request) {
  return runBff((bff) => bff.session(request));
}
