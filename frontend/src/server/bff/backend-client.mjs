// Chamadas do BFF ao FastAPI: destino fixo, sem redirecionamentos, com timeout e limites.
// Cabeçalhos são MONTADOS do zero (nada do navegador é repassado).

const NOT_SENT = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH"]);
const MAX_RESPONSE_BYTES = 1024 * 1024;

/**
 * @returns {Promise<
 *   | { kind: "response", status: number, json: any, headers: Headers }
 *   | { kind: "unreachable" }          // a requisição comprovadamente não saiu
 *   | { kind: "uncertain", reason: string }  // pode ter sido processada (timeout, rede, redirect)
 * >}
 */
export async function callBackend(ctx, { method, path, token, body, clientIp }) {
  const { config, fetchImpl } = ctx;
  if (!path.startsWith("/") || path.includes("..") || path.includes("//")) throw new Error("caminho inválido");
  const headers = { accept: "application/json" };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (token) headers.authorization = `Bearer ${token}`;
  if (config.proxySecret && clientIp) {
    headers["x-prazoai-proxy-secret"] = config.proxySecret;
    headers["x-prazoai-client-ip"] = clientIp;
  }
  let res;
  try {
    res = await fetchImpl(`${config.backendBase}/api/v1${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "manual",
      cache: "no-store",
      signal: AbortSignal.timeout(config.timeoutMs),
    });
  } catch (err) {
    const code = err?.cause?.code || err?.code;
    if (NOT_SENT.has(code)) return { kind: "unreachable" };
    if (err?.name === "TimeoutError" || err?.name === "AbortError") return { kind: "uncertain", reason: "timeout" };
    return { kind: "uncertain", reason: "network" };
  }
  if (res.status >= 300 && res.status < 400) return { kind: "uncertain", reason: "redirect" };
  let json = null;
  try {
    const text = await res.text();
    if (text.length > MAX_RESPONSE_BYTES) return { kind: "uncertain", reason: "oversized" };
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { kind: "response", status: res.status, json, headers: res.headers };
}
