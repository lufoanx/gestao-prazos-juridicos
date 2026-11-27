// BFF (doc 28): PDF da intimação. Rota PRÓPRIA (fora do proxy JSON) com limite de 10 MiB só aqui.
// PUT envia o PDF (corpo binário); GET devolve o anexo. Mesmas proteções: sessão, Origin/CSRF, tokens só no servidor.
import { runBff } from "@/server/bff/instance.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

type Ctx = { params: Promise<{ id: string }> };

export async function PUT(request: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  return runBff((bff) => bff.intimationFileUpload(request, id));
}

export async function GET(request: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  return runBff((bff) => bff.intimationFileDownload(request, id));
}
