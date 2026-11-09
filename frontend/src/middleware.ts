// Modo integrado (Etapa 6.1): reescreve rotas ainda não integradas ou indisponíveis para
// páginas explicativas, para que nenhuma tela demonstrativa apareça como real.
// Não é mecanismo de autorização (o servidor/BFF é a autoridade).
import { NextResponse, type NextRequest } from "next/server";
import { routeDecision } from "@/lib/integration/routes.mjs";
import { APP_MODE } from "@/lib/integration/mode.mjs";

export function middleware(request: NextRequest) {
  const decision = routeDecision(request.nextUrl.pathname, APP_MODE);
  if (decision.action === "rewrite") {
    const url = request.nextUrl.clone();
    url.pathname = decision.to;
    url.search = "";
    return NextResponse.rewrite(url);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/|favicon.ico|.*\\.(?:svg|png|jpg|ico|css|js)$).*)"],
};
