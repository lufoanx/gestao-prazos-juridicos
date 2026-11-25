// Cliente HTTP do navegador para o BFF (modo integrado). Centralizado e tipado (.d.mts).
//
// - Sempre envia o cabeçalho próprio anti-CSRF e cookies só da mesma origem.
// - Sem cache e SEM fallback demonstrativo: falha vira ApiError com categoria explícita.
// - "Época" da sessão: login, logout, troca de usuário ou de ambiente incrementam a época;
//   respostas de épocas anteriores são descartadas (StaleResponseError) e as requisições
//   pendentes são abortadas — dados de uma sessão anterior nunca voltam à tela.

export const CSRF_HEADER = "x-prazoai-csrf";

export class ApiError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.retryAfter = extra.retryAfter ?? null;
    this.outcome = extra.outcome ?? null;
  }

  /** Categoria para a interface: estados distintos, nunca "tudo é expiração". */
  get category() {
    if (this.status === 0) return "network";
    if (this.status === 401) return "session";
    if (this.status === 403) return "forbidden";
    if (this.status === 404) return "not_found";
    if (this.status === 409) return "conflict";
    if (this.status === 422) return "validation";
    if (this.status === 429) return "rate_limited";
    if (this.status === 504 && this.outcome === "unknown") return "unknown_outcome";
    if (this.status >= 500) return "unavailable";
    return "error";
  }
}

export class StaleResponseError extends Error {
  constructor() { super("resposta de uma sessão anterior descartada"); this.name = "StaleResponseError"; }
}

export function createApiClient({ fetchImpl = (...a) => fetch(...a), base = "" } = {}) {
  let epoch = 0;
  const pending = new Set();

  /**
   * Núcleo comum: CSRF, mesma origem, sem cache, época e erros categorizados.
   * `bodyInit`/`headers` já montados pelo chamador; `parse(res)` lê o corpo de sucesso.
   */
  async function send(method, path, { body, headers = {} }, parse) {
    if (!path.startsWith("/bff/")) throw new Error("o cliente só fala com o BFF");
    const myEpoch = epoch;
    const ac = new AbortController();
    pending.add(ac);
    try {
      let res;
      try {
        res = await fetchImpl(base + path, {
          method,
          headers: { [CSRF_HEADER]: "1", ...headers },
          body,
          credentials: "same-origin",
          cache: "no-store",
          signal: ac.signal,
        });
      } catch {
        if (myEpoch !== epoch) throw new StaleResponseError();
        throw new ApiError(0, "network_error", "Sem conexão com o servidor.");
      }
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        if (myEpoch !== epoch) throw new StaleResponseError();
        throw new ApiError(res.status, data?.error?.code || "http_error", data?.error?.message || "Erro inesperado.", {
          retryAfter: res.headers.get("retry-after"),
          outcome: data?.outcome,
        });
      }
      const value = await parse(res);
      if (myEpoch !== epoch) throw new StaleResponseError();
      return value;
    } catch (e) {
      if (myEpoch !== epoch && !(e instanceof StaleResponseError)) throw new StaleResponseError();
      throw e;
    } finally {
      pending.delete(ac);
    }
  }

  function request(method, path, body) {
    return send(method, path, {
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: body !== undefined ? { "content-type": "application/json" } : {},
    }, async (res) => (res.status === 204 ? null : await res.json().catch(() => null)));
  }

  /** Envio BINÁRIO (ex.: PDF): corpo e cabeçalhos explícitos; resposta JSON. */
  function upload(method, path, blob, headers) {
    return send(method, path, { body: blob, headers }, async (res) => await res.json().catch(() => null));
  }

  /** Download autenticado (com o cabeçalho anti-CSRF): devolve o Blob e o nome do anexo. */
  function download(path) {
    return send("GET", path, {}, async (res) => {
      const disposition = res.headers.get("content-disposition") || "";
      const star = /filename\*=UTF-8''([^;]+)/i.exec(disposition);
      const plain = /filename="([^"]*)"/i.exec(disposition);
      let fileName = plain?.[1] || "documento.pdf";
      if (star) { try { fileName = decodeURIComponent(star[1]); } catch { /* mantém o simples */ } }
      return { blob: await res.blob(), fileName, contentType: res.headers.get("content-type") || "" };
    });
  }

  return {
    request,
    upload,
    download,
    get epoch() { return epoch; },
    /** Nova época: aborta pendentes; respostas antigas passam a ser descartadas. */
    bumpEpoch() {
      epoch += 1;
      for (const ac of pending) ac.abort();
      pending.clear();
    },
  };
}
