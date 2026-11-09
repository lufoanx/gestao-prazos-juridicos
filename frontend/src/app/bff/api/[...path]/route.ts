// BFF (Etapa 6.1): proxy RESTRITO à lista explícita de rotas (src/server/bff/allowlist.mjs).
// Destino fixo no servidor; nenhuma URL vem do cliente; sem cache.
import { runBff, unavailableResponse } from "@/server/bff/instance.mjs";
import { segmentsToPath } from "@/server/bff/allowlist.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

type Ctx = { params: Promise<{ path: string[] }> };

async function handle(request: Request, ctx: Ctx) {
  const { path } = await ctx.params;
  const target = segmentsToPath(path);
  if (!target) return unavailableResponse();
  return runBff((bff) => bff.proxy(request, target));
}

export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
