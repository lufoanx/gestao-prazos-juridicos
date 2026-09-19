"use client";
import { useEffect, useMemo, useRef } from "react";
import { useScope } from "@/context/ScopeContext";
import { useData } from "@/context/DataContext";
import { canWriteIntimation } from "@/lib/deadline-guards.mjs";
import { getDemoToday } from "@/lib/clock.mjs";
import { addDays } from "@/lib/dates.mjs";
import type { IntimationSuggestion } from "@/lib/data-ops.d.mts";

const PROCESS_DELAY_MS = 1200;

// Extração SIMULADA — NÃO deriva do PDF. Apenas exemplos para conferência humana.
const TITLES = ["Manifestação sobre documentos", "Contrarrazões de apelação", "Recurso ordinário", "Réplica", "Cumprimento de sentença"];
const COURTS = ["TJSC · 2ª Vara Cível", "TRT 12ª Região · 3ª Vara", "TJSC · Vara da Fazenda Pública"];
const AREAS = ["Cível", "Trabalhista", "Tributário", "Família"];
const pick = <T,>(arr: T[]) => arr[Math.floor(Math.random() * arr.length)];
function simulateExtraction(responsibleId: string): IntimationSuggestion {
  const r = () => Math.floor(10 + Math.random() * 89);
  return {
    suggestedTitle: pick(TITLES),
    suggestedCaseNumber: `00${Math.floor(10000 + Math.random() * 89999)}-${r()}.2026.8.24.00${r()}`,
    suggestedCourt: pick(COURTS),
    suggestedArea: pick(AREAS),
    suggestedResponsibleId: responsibleId,
    suggestedDueDate: addDays(getDemoToday(), 10),
  };
}

/**
 * Processador central do fluxo SIMULADO de intimações. Montado uma vez na casca
 * (dentro do DataProvider), resolve qualquer intimação em "processing" acessível
 * no ambiente atual — funcionando após navegar OU recarregar a página, e sem
 * deixar nada eternamente em "processing". O desfecho vem de demoForceFail
 * (persistido). O isolamento é preservado: só resolve o que o contexto atual pode
 * escrever, e trocas de ambiente cancelam timers pendentes.
 */
export function IntimationProcessor() {
  const { scope, scopeKind, user, membership } = useScope();
  const { intimations, processIntimation } = useData();
  const ctx = useMemo(() => ({ scope, scopeKind, userId: user.id, membership }), [scope, scopeKind, user.id, membership]);
  const timers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  useEffect(() => {
    const map = timers.current;
    const pending = intimations.filter((i) => i.status === "processing" && canWriteIntimation(i, ctx, "deadline.create"));
    const pendingIds = new Set(pending.map((i) => i.id));

    // Cancela timers de itens que saíram de "processing" ou do ambiente atual.
    for (const [id, t] of map) {
      if (!pendingIds.has(id)) { clearTimeout(t); map.delete(id); }
    }
    // Agenda os pendentes ainda sem timer.
    for (const intim of pending) {
      if (map.has(intim.id)) continue;
      const forceFail = intim.demoForceFail === true;
      const t = setTimeout(() => {
        map.delete(intim.id);
        if (forceFail) processIntimation(intim.id, "fail", null);
        else processIntimation(intim.id, "success", simulateExtraction(ctx.userId));
      }, PROCESS_DELAY_MS);
      map.set(intim.id, t);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intimations, ctx]);

  // Limpa todos os timers ao desmontar.
  useEffect(() => {
    const map = timers.current;
    return () => { for (const [, t] of map) clearTimeout(t); map.clear(); };
  }, []);

  return null;
}
