// BFF — Entrar com Google: início: gera state/nonce/PKCE e redireciona ao Google. Sem cache; nenhum token chega ao navegador.
import { runBff } from "@/server/bff/instance.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(request: Request) {
  return runBff((bff) => bff.googleStart(request));
}
