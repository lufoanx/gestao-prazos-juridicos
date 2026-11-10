// INFRAESTRUTURA SIMULADA DO E2E (não faz parte da aplicação).
//
// Representa o proxy reverso de borda que, numa implantação, fica diante do Next e é a ÚNICA
// fonte confiável do IP do cliente. É aqui — e só aqui — que o cabeçalho confiável
// `x-prazoai-e2e-client-ip` é DEFINIDO/SOBRESCRITO:
//   1. a identidade de rede do cliente vem do cookie `e2e_client_ip`, colocado pelo HARNESS no
//      BrowserContext (HttpOnly: o código da página não lê nem altera); o valor precisa ser um
//      endereço de documentação (203.0.113.0/24 ou 198.51.100.0/24);
//   2. o cookie é REMOVIDO antes de repassar (o Next/BFF nunca o vê);
//   3. qualquer valor recebido do navegador para o cabeçalho confiável, X-Forwarded-For, X-Real-IP,
//      Forwarded ou cabeçalhos internos do PrazoAI é DESCARTADO;
//   4. sem identidade válida, nenhum IP é encaminhado (o BFF cai no comportamento padrão).
// Origin, cookies da aplicação, métodos e corpos passam intactos. O `Host` repassado é o do próprio
// Next (localhost:<porta interna>), como num proxy reverso que fala com o upstream pelo endereço
// interno; assim as reescritas do middleware continuam internas. Escuta só em endereço local e não
// tem rotas de controle.
import { createServer, request as httpRequest } from "node:http";

export const TRUSTED_HEADER = "x-prazoai-e2e-client-ip";
export const IDENTITY_COOKIE = "e2e_client_ip";
const TEST_NET = /^(203\.0\.113|198\.51\.100)\.([1-9]|[1-9]\d|1\d\d|2[0-4]\d|25[0-4])$/;
const DROP = new Set([TRUSTED_HEADER, "x-forwarded-for", "x-real-ip", "forwarded", "x-prazoai-client-ip", "x-prazoai-proxy-secret"]);

/** Separa a identidade do harness dos cookies da aplicação. */
export function splitIdentity(cookieHeader) {
  let ip = null;
  const rest = [];
  for (const part of (cookieHeader ?? "").split(";")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const i = trimmed.indexOf("=");
    const name = i < 0 ? trimmed : trimmed.slice(0, i);
    if (name === IDENTITY_COOKIE) { const v = trimmed.slice(i + 1); if (TEST_NET.test(v)) ip = v; continue; }
    rest.push(trimmed);
  }
  return { ip, cookie: rest.join("; ") };
}

/** Cabeçalhos repassados ao Next: identidade aplicada pela borda, nada decidido pelo navegador. */
export function edgeHeaders(incoming, upstreamHost) {
  const out = {};
  for (const [k, v] of Object.entries(incoming)) {
    if (v === undefined || DROP.has(k.toLowerCase()) || k.toLowerCase() === "cookie") continue;
    out[k] = v;
  }
  const { ip, cookie } = splitIdentity(Array.isArray(incoming.cookie) ? incoming.cookie.join("; ") : incoming.cookie);
  if (cookie) out.cookie = cookie;
  if (ip) out[TRUSTED_HEADER] = ip;
  if (upstreamHost) { delete out.host; out.host = upstreamHost; }
  return out;
}

export async function startEdgeProxy({ listenPort, targetPort }) {
  const server = createServer((req, res) => {
    const upstream = httpRequest({ host: "127.0.0.1", port: targetPort, path: req.url, method: req.method, headers: edgeHeaders(req.headers, `localhost:${targetPort}`) }, (up) => {
      res.writeHead(up.statusCode || 502, up.headers);
      up.pipe(res);
    });
    upstream.on("error", () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    req.pipe(upstream);
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(listenPort, "127.0.0.1", resolve); });
  // "localhost" pode resolver para ::1 no navegador; atende também o loopback IPv6, se disponível.
  const v6 = createServer(server.listeners("request")[0]);
  await new Promise((resolve) => { v6.once("error", () => resolve()); v6.listen(listenPort, "::1", resolve); });
  return { close: () => Promise.all([new Promise((r) => server.close(r)), new Promise((r) => v6.close(() => r()))]) };
}
