"use client";
// Estado das telas de recuperação (E5) ligado ao React. As regras ficam em
// src/lib/integration/recovery-flow.mjs (puras, testadas sem navegador); aqui só há efeitos:
// consulta de disponibilidade, captura do fragmento, envio único e fim da espera do Retry-After.
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { createRecoveryClient } from "@/lib/integration/recovery-client.mjs";
import { createFragmentTokenHolder, type FragmentTokenHolder } from "@/lib/integration/fragment-token.mjs";
import {
  FORGOT_INITIAL, RESET_INITIAL, checkForgotForm, checkResetForm, classifyForgotError, classifyResetError,
  createSingleFlight, forgotReducer, resetReducer,
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
export function useResetFlow() {
  const client = useMemo(() => createRecoveryClient(), []);
  const [state, dispatch] = useReducer(resetReducer, RESET_INITIAL);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const holder = useRef<FragmentTokenHolder | null>(null);
  if (holder.current === null) holder.current = createFragmentTokenHolder();
  const flight = useRef(createSingleFlight());

  // Captura no cliente, uma vez por instância (efeitos repetidos devolvem o mesmo token); um novo
  // link aberto na mesma aba (hashchange) substitui o anterior. O token NUNCA entra no estado do
  // React nem no DOM: fica no objeto `holder`, fora da renderização.
  useEffect(() => {
    const read = () => {
      const { token } = holder.current!.capture(window);
      dispatch({ type: "captured", hasToken: token !== null });
    };
    read();
    const onHash = () => { if (window.location.hash) read(); };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const endCooldown = useCallback(() => dispatch({ type: "cooldown", waiting: false }), []);
  useCooldown(state.phase === "rate_limited" ? state.waiting : false, state.retryAfter, endCooldown);

  const submit = useCallback(async () => {
    const errors = checkResetForm({ password, confirm });
    if (errors.password || errors.confirm) {
      if (errors.password) dispatch({ type: "invalid", error: errors.password, field: "password" });
      else dispatch({ type: "invalid", error: errors.confirm!, field: "confirm" });
      return errors;
    }
    const token = holder.current!.token;
    if (!token) { dispatch({ type: "captured", hasToken: false }); return {}; }
    await flight.current.run(async () => {
      dispatch({ type: "submit" });
      try {
        await client.reset(token, password);
        holder.current!.clear();                                // token e senhas saem da memória
        setPassword("");
        setConfirm("");
        dispatch({ type: "success" });
      } catch (e) {
        const outcome = classifyResetError(e);
        if (outcome.dropToken) holder.current!.clear();
        dispatch({ type: "failed", outcome });                  // nunca repete sozinho
      }
    });
    return {};
  }, [client, password, confirm]);

  const edit = useCallback(() => dispatch({ type: "edit" }), []);
  return { state, password, setPassword, confirm, setConfirm, submit, edit };
}
