// BFF (Etapa 6.1): logout. Sem cache; tokens nunca chegam ao navegador.
import { runBff } from "@/server/bff/instance.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function POST(request: Request) {
  return runBff((bff) => bff.logout(request));
}
