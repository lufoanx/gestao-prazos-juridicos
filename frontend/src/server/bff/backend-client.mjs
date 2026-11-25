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
export async function callBackend(ctx, { method, path, token, body, clientIp, query = "", raw, timeoutMs }) {
  const { config } = ctx;
  const maxBytes = ctx.maxResponseBytes ?? MAX_RESPONSE_BYTES;
  if (!path.startsWith("/") || path.includes("..") || path.includes("//") || /[?#\\]/.test(path)) throw new Error("caminho inválido");
  // Query já validada e remontada pelo BFF (URLSearchParams): só caracteres de query codificada.
  if (query && !/^[A-Za-z0-9%=&+._*~-]+$/.test(query)) throw new Error("query inválida");
  const headers = { accept: "application/json" };
  if (body !== undefined) headers["content-type"] = "application/json";
  // Corpo BINÁRIO (doc 28): bytes já lidos com teto pelo BFF; cabeçalhos montados do zero.
  if (raw) {
    headers["content-type"] = raw.contentType;
    for (const [k, v] of Object.entries(raw.headers ?? {})) headers[k] = v;
  }
  if (token) headers.authorization = `Bearer ${token}`;
  if (config.proxySecret && clientIp) {
    headers["x-prazoai-proxy-secret"] = config.proxySecret;
    headers["x-prazoai-client-ip"] = clientIp;
  }
  // Timer explícito (não "unref"): o mesmo prazo vale para a conexão E para a leitura do corpo.
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new DOMException("tempo esgotado", "TimeoutError")), timeoutMs ?? config.timeoutMs);
  try {
    return await exchange(ctx, ac.signal, maxBytes, { method, path: query ? `${path}?${query}` : path, headers, body, raw });
  } finally {
    clearTimeout(timer);
  }
}

async function exchange(ctx, signal, maxBytes, { method, path, headers, body, raw }) {
  const { config, fetchImpl } = ctx;
  let res;
  try {
    res = await fetchImpl(`${config.backendBase}/api/v1${path}`, {
      method,
      headers,
      body: raw ? raw.bytes : body === undefined ? undefined : JSON.stringify(body),
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

/**
 * Download BINÁRIO do backend (doc 28). Mesmo destino fixo, sem redirecionamento e com prazo que vale
 * para a transferência inteira. Sucesso (200): devolve o fluxo do corpo com teto de bytes (o que
 * passar do teto ou do `Content-Length` declarado interrompe o fluxo). Erros: corpo JSON lido com teto.
 * @returns {Promise<
 *   | { kind: "stream", headers: Headers, body: ReadableStream<Uint8Array>, done: () => void }
 *   | { kind: "response", status: number, json: any, headers: Headers }
 *   | { kind: "unreachable" } | { kind: "uncertain", reason: string }
 * >}
 */
export async function fetchBackendFile(ctx, { path, token, clientIp, timeoutMs, maxBytes }) {
  const { config, fetchImpl } = ctx;
  if (!path.startsWith("/") || path.includes("..") || path.includes("//") || /[?#\\]/.test(path)) throw new Error("caminho inválido");
  const headers = { accept: "application/pdf, application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  if (config.proxySecret && clientIp) {
    headers["x-prazoai-proxy-secret"] = config.proxySecret;
    headers["x-prazoai-client-ip"] = clientIp;
  }
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new DOMException("tempo esgotado", "TimeoutError")), timeoutMs);
  const done = () => clearTimeout(timer);
  let res;
  try {
    res = await fetchImpl(`${config.backendBase}/api/v1${path}`, { method: "GET", headers, redirect: "manual", cache: "no-store", signal: ac.signal });
  } catch (err) {
    done();
    const code = err?.cause?.code || err?.code;
    if (NOT_SENT.has(code)) return { kind: "unreachable" };
    return { kind: "uncertain", reason: ac.signal.aborted ? "timeout" : "network" };
  }
  if (res.status >= 300 && res.status < 400) {
    done();
    await res.body?.cancel().catch(() => {});
    return { kind: "uncertain", reason: "redirect" };
  }
  if (res.status !== 200) {
    const read = await readBody(res, ac.signal, MAX_RESPONSE_BYTES);
    done();
    let json = null;
    try { json = read.ok && read.text ? JSON.parse(read.text) : null; } catch { json = null; }
    return { kind: "response", status: res.status, json, headers: res.headers };
  }
  const declared = Number(res.headers.get("content-length"));
  if (!res.body || !Number.isInteger(declared) || declared < 1 || declared > maxBytes) {
    done();
    await res.body?.cancel().catch(() => {});
    return { kind: "uncertain", reason: "invalid_body" };
  }
  let seen = 0;
  const limited = res.body.pipeThrough(new TransformStream({
    transform(chunk, controller) {
      seen += chunk.byteLength;
      if (seen > declared) { controller.error(new Error("corpo maior que o declarado")); ac.abort(); return; }
      controller.enqueue(chunk);
    },
    flush() { done(); },
  }));
  return { kind: "stream", headers: res.headers, body: limited, done };
}
