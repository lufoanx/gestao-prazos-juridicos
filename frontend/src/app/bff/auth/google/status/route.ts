// BFF — Entrar com Google: disponibilidade (o botão só aparece se estiver configurado). Sem cache; nenhum token chega ao navegador.
import { runBff } from "@/server/bff/instance.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET() {
  return runBff((bff) => bff.googleStatus());
}
