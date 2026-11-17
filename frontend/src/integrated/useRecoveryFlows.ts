"use client";
// Estado das telas de recuperação (E5) ligado ao React. As regras ficam em
// src/lib/integration/recovery-flow.mjs (puras, testadas sem navegador); aqui só há efeitos:
// consulta de disponibilidade, captura do fragmento, envio único e fim da espera do Retry-After.
import { useCallback, useEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore } from "react";
import { createRecoveryClient } from "@/lib/integration/recovery-client.mjs";
import { createResetController, type ResetController } from "@/lib/integration/reset-controller.mjs";
import {
  FORGOT_INITIAL, checkForgotForm, classifyForgotError, createSingleFlight, forgotReducer,
} from "@/lib/integration/recovery-flow.mjs";

/** Libera nova tentativa só depois do Retry-After (um único temporizador, cancelado ao sair). */
function useCooldown(waiting: boolean | undefined, seconds: number | null | undefined, done: () => void) {
  useEffect(() => {
    if (!waiting || !seconds) return;
    const t = window.setTimeout(done, seconds * 1000);
    return () => window.clearTimeout(t);
  }, [waiting, seconds, done]);
}

// ---------------------------------------------------------------------------------- /esqueci-senha
export function useForgotFlow() {
  const client = useMemo(() => createRecoveryClient(), []);
  const [state, dispatch] = useReducer(forgotReducer, FORGOT_INITIAL);
  const [email, setEmail] = useState("");
  const flight = useRef(createSingleFlight());
  const statusSeq = useRef(0);

  /** Consulta de disponibilidade: ao abrir e, depois de uma falha, só por ação explícita. */
  const check = useCallback(() => {
    const seq = ++statusSeq.current;
    dispatch({ type: "check" });
    client.status()
      .then((r) => { if (seq === statusSeq.current) dispatch({ type: "status", available: r.available }); })
      .catch(() => { if (seq === statusSeq.current) dispatch({ type: "status_failed" }); });
  }, [client]);

  useEffect(() => {
    check();
    return () => { statusSeq.current += 1; };                  // resposta de uma montagem anterior é ignorada
  }, [check]);

  const endCooldown = useCallback(() => dispatch({ type: "cooldown", waiting: false }), []);
  useCooldown(state.phase === "rate_limited" ? state.waiting : false, state.retryAfter, endCooldown);

  const submit = useCallback(async () => {
    const errors = checkForgotForm(email);
    if (errors.email) { dispatch({ type: "invalid", error: errors.email, field: "email" }); return; }
    await flight.current.run(async () => {
      dispatch({ type: "submit" });
      try {
        await client.forgot(email.trim());
        dispatch({ type: "accepted" });
      } catch (e) {
        dispatch({ type: "failed", outcome: classifyForgotError(e) });      // nunca repete sozinho
      }
    });
  }, [client, email]);

  const edit = useCallback(() => dispatch({ type: "edit" }), []);
  return { state, email, setEmail, submit, check, edit };
}

// ------------------------------------------------------------------------------- /redefinir-senha
// A coordenação (captura com revisões, estado, envio único, respostas de links substituídos) está em
// src/lib/integration/reset-controller.mjs; aqui só há a assinatura e os efeitos do navegador.
export function useResetFlow() {
  const ctl = useRef<ResetController | null>(null);
  if (ctl.current === null) {
    ctl.current = createResetController({ client: createRecoveryClient(), getWindow: () => window });
  }
  const c = ctl.current;
  const snap = useSyncExternalStore(c.subscribe, () => c.snapshot, () => c.snapshot);

  // Captura no cliente, uma vez por instância (efeitos repetidos devolvem o mesmo token); um novo
  // link aberto na mesma aba (hashchange) é lido e removido da barra imediatamente, mesmo durante
  // um envio. O token NUNCA entra no estado do React nem no DOM.
  useEffect(() => {
    c.read();
    const onHash = () => { if (window.location.hash) c.read(); };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, [c]);

  const endCooldown = useCallback(() => c.endCooldown(), [c]);
  useCooldown(snap.state.phase === "rate_limited" ? snap.state.waiting : false, snap.state.retryAfter, endCooldown);

  return {
    state: snap.state, password: snap.password, confirm: snap.confirm,
    setPassword: c.setPassword, setConfirm: c.setConfirm,
    submit: c.submit, edit: c.edit,
  };
}
