"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { Send, Trash2, Bot, User as UserIcon, AlertTriangle } from "lucide-react";
import { useScope } from "@/context/ScopeContext";
import { useData } from "@/context/DataContext";
import { useSession } from "@/context/SessionContext";
import { canReadDeadline } from "@/lib/access.mjs";
import { canAccessIntimation } from "@/lib/deadline-guards.mjs";
import { buildDashboard } from "@/lib/dashboard.mjs";
import { getDemoToday } from "@/lib/clock.mjs";
import { newId } from "@/lib/ids.mjs";
import { DEMO_USER_ID } from "@/mocks/data";
import { SUGGESTIONS, DISCLAIMER, generateAnswer } from "@/lib/assistant.mjs";
import { Button } from "@/components/ui";

interface Msg { id: string; role: "user" | "assistant"; text: string }
interface Conv { key: string; msgs: Msg[] }
const STORAGE_KEY = "prazoai:demo-assistant:v1";

function readStore(): Record<string, Msg[]> {
  try { const raw = localStorage.getItem(STORAGE_KEY); return raw ? JSON.parse(raw) : {}; } catch { return {}; }
}

export default function AssistentePage() {
  const { scope, scopeKind, user, membership, office } = useScope();
  const { deadlines, intimations } = useData();
  const { session, hydrated } = useSession();
  const today = getDemoToday();
  const userId = session.user?.id ?? DEMO_USER_ID;

  // Chave da conversa = usuário + AMBIENTE ATIVO (pessoal ou escritório específico).
  const convKey = useMemo(() => {
    const env = scope.kind === "personal" ? `p:${scope.ownerId}` : `o:${scope.officeId}`;
    return `${userId}|${env}`;
  }, [userId, scope]);

  // A conversa carrega a própria chave junto das mensagens: mensagens e chave
  // sempre viajam juntas, então nunca gravamos mensagens antigas na chave nova.
  const [conv, setConv] = useState<Conv>({ key: convKey, msgs: [] });
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const keyRef = useRef(convKey);
  keyRef.current = convKey;

  const cancelPending = () => { if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; } setLoading(false); };

  // Troca de usuário/ambiente: cancela resposta pendente e carrega SÓ a conversa da chave.
  useEffect(() => {
    if (!hydrated) return;
    cancelPending();
    const store = readStore();
    setConv({ key: convKey, msgs: Array.isArray(store[convKey]) ? store[convKey] : [] });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [convKey, hydrated]);

  // Persiste a conversa sob a SUA própria chave (nunca sob outra).
  useEffect(() => {
    if (!hydrated) return;
    const store = readStore();
    store[conv.key] = conv.msgs;
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(store)); } catch { /* ignora */ }
  }, [conv, hydrated]);

  // Cancela qualquer resposta pendente ao sair da página.
  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current); }, []);

  useEffect(() => { listRef.current?.scrollTo({ top: listRef.current.scrollHeight }); }, [conv.msgs, loading]);

  // Contexto = ambiente ATIVO, com escopo + PERMISSÕES (prazos e intimações).
  const ctx = useMemo(() => {
    const inScope = (s: { kind: "personal"; ownerId: string } | { kind: "office"; officeId: string }) => {
      if (s.kind !== scope.kind) return false;
      if (scope.kind === "personal" && s.kind === "personal") return s.ownerId === scope.ownerId;
      if (scope.kind === "office" && s.kind === "office") return s.officeId === scope.officeId;
      return false;
    };
    const visible = deadlines.filter((d) => inScope(d.scope) && canReadDeadline(user.id, membership, d));
    // Resolve o responsável do prazo vinculado (para visibilidade "assigned").
    const responsibleOf = (deadlineId: string) => deadlines.find((d) => d.id === deadlineId)?.responsibleId;
    const gctx = { scope, scopeKind, userId: user.id, membership };
    const intis = intimations.filter((i) => canAccessIntimation(i, gctx, responsibleOf));
    const o = buildDashboard(visible, intis, today).overview;
    return {
      open: o.open, overdue: o.overdue, dueSoon: o.soon + o.dueToday, reviews: o.awaitingReview,
      scopeLabel: scopeKind === "office" ? `do escritório ${office?.name ?? ""}`.trim() : "pessoal",
    };
  }, [deadlines, intimations, scope, scopeKind, user.id, membership, office, today]);

  function ask(text: string) {
    const q = text.trim();
    if (!q || loading) return;
    const askedKey = convKey;
    setConv((c) => ({ key: c.key, msgs: [...c.msgs, { id: newId("m"), role: "user", text: q }] }));
    setInput("");
    setLoading(true);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      // Só entrega a resposta se o ambiente/usuário não mudou.
      if (keyRef.current !== askedKey) { setLoading(false); return; }
      const answer = generateAnswer(q, ctx);
      setConv((c) => (c.key === askedKey ? { key: c.key, msgs: [...c.msgs, { id: newId("m"), role: "assistant", text: answer }] } : c));
      setLoading(false);
    }, 700);
  }

  function clearConversation() {
    cancelPending();
    setConv((c) => ({ key: c.key, msgs: [] }));
  }

  const messages = conv.msgs;

  return (
    <div>
      <div className="page-head">
        <div className="page-head__title">
          <h1 style={{ fontSize: "var(--fs-2xl)", fontWeight: 700, color: "var(--text-strong)", margin: 0 }}>Assistente</h1>
          <p className="page-head__subtitle">Organização de prazos e uso da PrazoAI · ambiente {ctx.scopeLabel}</p>
        </div>
        {messages.length > 0 ? (
          <div className="page-head__actions">
            <Button variant="secondary" onClick={clearConversation}><Trash2 size={16} aria-hidden /> Limpar conversa</Button>
          </div>
        ) : null}
      </div>

      <div className="review-banner">
        <AlertTriangle size={18} aria-hidden />
        <span>{DISCLAIMER}</span>
      </div>

      <div className="chat">
        <div className="chat__log" ref={listRef} role="log" aria-live="polite" aria-label="Conversa do assistente">
          {messages.length === 0 ? (
            <div className="chat__empty">
              <Bot size={30} aria-hidden />
              <p>Como posso ajudar na organização dos seus prazos?</p>
              <span>Escolha uma sugestão abaixo ou escreva sua pergunta.</span>
            </div>
          ) : messages.map((m) => (
            <div key={m.id} className={`chat__msg chat__msg--${m.role}`}>
              <span className="chat__avatar" aria-hidden>{m.role === "assistant" ? <Bot size={16} /> : <UserIcon size={16} />}</span>
              <div className="chat__bubble">{m.text}</div>
            </div>
          ))}
          {loading ? (
            <div className="chat__msg chat__msg--assistant">
              <span className="chat__avatar" aria-hidden><Bot size={16} /></span>
              <div className="chat__bubble chat__bubble--typing"><span></span><span></span><span></span></div>
            </div>
          ) : null}
        </div>

        <div className="chat__suggestions" aria-label="Sugestões de perguntas">
          {SUGGESTIONS.map((s) => (
            <button key={s} className="chat__chip" onClick={() => ask(s)} disabled={loading}>{s}</button>
          ))}
        </div>

        <form className="chat__form" onSubmit={(e) => { e.preventDefault(); ask(input); }}>
          <input
            className="input chat__input" value={input} onChange={(e) => setInput(e.target.value)}
            placeholder="Pergunte sobre seus prazos ou a PrazoAI…" aria-label="Mensagem para o assistente" disabled={loading}
          />
          <Button type="submit" variant="primary" disabled={loading || !input.trim()} aria-label="Enviar">
            <Send size={16} aria-hidden /> Enviar
          </Button>
        </form>
      </div>
    </div>
  );
}
