// BFF — Entrar com Google: retorno: confere o state, troca o código e cria a sessão. Sem cache; nenhum token chega ao navegador.
import { runBff } from "@/server/bff/instance.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(request: Request) {
  return runBff((bff) => bff.googleCallback(request));
}
