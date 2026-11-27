// BFF: disponibilidade (configuração + armazenamento de sessões). Sem cache e sem dados internos.
import { healthResponse } from "@/server/bff/instance.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET() {
  return healthResponse();
}
