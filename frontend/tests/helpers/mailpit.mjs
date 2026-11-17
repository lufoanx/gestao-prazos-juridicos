// Cliente de TESTE da API do capturador Mailpit (E3/E4). Nunca usado pelo código do produto.
// Só aceita API em loopback. As mensagens devolvidas não expõem corpo em toString/inspeção.
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

export function mailpitFromEnv(env = process.env) {
  const api = env.PRAZOAI_TEST_MAILPIT_API;
  const smtp = env.PRAZOAI_TEST_MAILPIT_SMTP;
  if (!api || !smtp) return null;
  const url = new URL(api);
  const [host, port] = [smtp.slice(0, smtp.lastIndexOf(":")), smtp.slice(smtp.lastIndexOf(":") + 1)];
  if (url.protocol !== "http:" || !LOOPBACK.has(url.hostname) || !LOOPBACK.has(host) || !/^\d+$/.test(port)) {
    throw new Error("capturador SMTP deve ser local (loopback).");
  }
  return createMailpit(url.origin, { host, port });
}

class Captured {
  #text;
  constructor(id, to, text) { this.id = id; this.to = to; this.#text = text; }
  get text() { return this.#text; }
  toString() { return `Captured(${this.id})`; }
  toJSON() { return { id: this.id }; }
  [Symbol.for("nodejs.util.inspect.custom")]() { return this.toString(); }
}

function createMailpit(base, smtp) {
  const call = async (method, path) => {
    const r = await fetch(`${base}${path}`, { method });
    if (!r.ok) throw new Error(`capturador respondeu ${r.status}`);
    const t = await r.text();
    return t && (t[0] === "{" || t[0] === "[") ? JSON.parse(t) : null;
  };
  const mp = {
    smtp,
    async ready(timeoutMs = 30000) {
      const end = Date.now() + timeoutMs;
      for (;;) {
        try { if ((await fetch(`${base}/readyz`)).ok) return; } catch { /* subindo */ }
        if (Date.now() > end) throw new Error("capturador não respondeu (proteção contra travamento)");
        await new Promise((r) => setTimeout(r, 200));
      }
    },
    async count() { return (await call("GET", "/api/v1/messages?limit=1")).messages_count; },
    async deleteAll() { await call("DELETE", "/api/v1/messages"); },
    /** Espera a CONDIÇÃO observável "total ≥ n" (prazo só de proteção). */
    async waitCount(n, timeoutMs = 15000) {
      const end = Date.now() + timeoutMs;
      for (;;) {
        const c = await mp.count();
        if (c >= n || Date.now() > end) return c;
        await new Promise((r) => setTimeout(r, 100));
      }
    },
    /** Mensagens para `address` em ordem de chegada (mais antiga primeiro). */
    async messagesTo(address) {
      const found = await call("GET", `/api/v1/search?query=${encodeURIComponent(`to:"${address}"`)}&limit=200`);
      const out = [];
      for (const m of [...found.messages].reverse()) {
        const full = await call("GET", `/api/v1/message/${encodeURIComponent(m.ID)}`);
        out.push(new Captured(full.ID, (full.To || []).map((x) => x.Address), full.Text || ""));
      }
      return out;
    },
  };
  return mp;
}

/** Token do ÚNICO link de redefinição (no fragmento); nunca impresso. */
export function tokenFrom(message, origin) {
  const links = message.text.split(/\s+/).filter((w) => w.startsWith(`${origin}/redefinir-senha`));
  if (links.length !== 1) { const e = new Error("requisito não atendido: um único link de redefinição"); e.stack = e.message; throw e; }
  const u = new URL(links[0]);
  if (u.pathname !== "/redefinir-senha" || u.search || !u.hash) {
    const e = new Error("requisito não atendido: token só no fragmento"); e.stack = e.message; throw e;
  }
  return u.hash.slice(1);
}
