// Chamadas do BFF ao FastAPI: destino fixo, sem redirecionamentos, com timeout e limites.
// Cabeçalhos são MONTADOS do zero (nada do navegador é repassado).

const NOT_SENT = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH"]);
const MAX_RESPONSE_BYTES = 1024 * 1024;


/**
 * @returns {Promise<
 *   | { kind: "response", status: number, json: any, headers: Headers }
 *   | { kind: "unreachable" }          // a requisição comprovadamente não saiu
 *   | { kind: "uncertain", reason: string }  // pode ter sido processada (timeout, rede, redirect,
 *                                            //   corpo interrompido/ilegível/grande demais)
 * >}
 */
export async function callBackend(ctx, { method, path, token, body, clientIp }) {
  const { config } = ctx;
  const maxBytes = ctx.maxResponseBytes ?? MAX_RESPONSE_BYTES;
  if (!path.startsWith("/") || path.includes("..") || path.includes("//")) throw new Error("caminho inválido");
  const headers = { accept: "application/json" };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (token) headers.authorization = `Bearer ${token}`;
  if (config.proxySecret && clientIp) {
    headers["x-prazoai-proxy-secret"] = config.proxySecret;
    headers["x-prazoai-client-ip"] = clientIp;
  }
  // Timer explícito (não "unref"): o mesmo prazo vale para a conexão E para a leitura do corpo.
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new DOMException("tempo esgotado", "TimeoutError")), config.timeoutMs);
  try {
    return await exchange(ctx, ac.signal, maxBytes, { method, path, headers, body });
  } finally {
    clearTimeout(timer);
  }
}

async function exchange(ctx, signal, maxBytes, { method, path, headers, body }) {
  const { config, fetchImpl } = ctx;
  let res;
  try {
    res = await fetchImpl(`${config.backendBase}/api/v1${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "manual",
      cache: "no-store",
      signal,
    });
  } catch (err) {
    const code = err?.cause?.code || err?.code;
    if (NOT_SENT.has(code)) return { kind: "unreachable" };
    if (err?.name === "TimeoutError" || err?.name === "AbortError" || signal.aborted) {
      return { kind: "uncertain", reason: "timeout" };
    }
    return { kind: "uncertain", reason: "network" };
  }
  if (res.status >= 300 && res.status < 400) {
    await res.body?.cancel().catch(() => {});
    return { kind: "uncertain", reason: "redirect" };
  }
  // O corpo é lido em fluxo, com teto de bytes e o MESMO prazo: uma resposta só é "response"
  // se o corpo inteiro chegou e (quando há conteúdo) é JSON válido.
  const read = await readBody(res, signal, maxBytes);
  if (!read.ok) return { kind: "uncertain", reason: read.reason };
  let json = null;
  if (read.text) {
    try {
      json = JSON.parse(read.text);
    } catch {
      // 2xx com corpo ilegível: o efeito pode ter ocorrido → incerto. Erros (4xx/5xx) seguem como resposta.
      if (res.status < 400) return { kind: "uncertain", reason: "invalid_body" };
    }
  }
  return { kind: "response", status: res.status, json, headers: res.headers };
}

async function readBody(res, signal, maxBytes) {
  if (!res.body) return { ok: true, text: "" };
  const reader = res.body.getReader();
  const onAbort = () => { reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", onAbort, { once: true });
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      if (signal.aborted) return { ok: false, reason: "timeout" };
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => {});
        return { ok: false, reason: "oversized" };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, reason: signal.aborted ? "timeout" : "body_read_failed" };
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
  if (signal.aborted) return { ok: false, reason: "timeout" };
  return { ok: true, text: Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8") };
}
