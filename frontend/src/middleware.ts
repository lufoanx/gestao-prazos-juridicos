// Modo integrado (Etapa 6.1): reescreve rotas ainda não integradas ou indisponíveis para
// páginas explicativas, para que nenhuma tela demonstrativa apareça como real.
// Não é mecanismo de autorização (o servidor/BFF é a autoridade).
import { NextResponse, type NextRequest } from "next/server";
import { routeDecision } from "@/lib/integration/routes.mjs";
import { APP_MODE } from "@/lib/integration/mode.mjs";

// E5: o formato antigo do link de redefinição (/redefinir-senha/<token>) é reescrito, nos dois
// modos, para uma página estática; o caminho recebido nunca chega a uma página que o leia.
export function middleware(request: NextRequest) {
  const decision = routeDecision(request.nextUrl.pathname, APP_MODE);
  let response: NextResponse;
  if (decision.action === "rewrite") {
    const url = request.nextUrl.clone();
    url.pathname = decision.to;
    url.search = "";
    response = NextResponse.rewrite(url);
  } else {
    response = NextResponse.next();
  }
  if (decision.noReferrer) response.headers.set("Referrer-Policy", "no-referrer");
  return response;
}

export const config = {
  matcher: ["/((?!_next/|favicon.ico|.*\\.(?:svg|png|jpg|ico|css|js)$).*)"],
};
