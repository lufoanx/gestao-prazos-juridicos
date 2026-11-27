"use client";
// Entrar com Google (modo integrado). O botão só aparece quando o BFF está configurado; o fluxo é uma
// navegação de página inteira para /bff/auth/google/start (nada de tokens no navegador).
import { useEffect, useState } from "react";
import { UnavailableNote } from "./Unavailable";

const MESSAGES: Record<string, string> = {
  cancelado: "O login com Google foi cancelado.",
  expirado: "A tentativa de login com Google expirou. Tente de novo.",
  limite: "Muitas tentativas. Aguarde alguns minutos e tente de novo.",
  conta: "Não foi possível confirmar sua conta Google. Use uma conta com e-mail verificado.",
  indisponivel: "Entrar com Google está indisponível no momento. Tente de novo ou use e-mail e senha.",
  falhou: "Não foi possível entrar com Google. Tente de novo.",
};

/** Mensagem do retorno do Google (`/login?google=<motivo>`), lida uma vez e removida da barra. */
function useGoogleReturnMessage() {
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => {
    const url = new URL(window.location.href);
    const reason = url.searchParams.get("google");
    if (!reason) return;
    setMessage(MESSAGES[reason] ?? MESSAGES.falhou);
    url.searchParams.delete("google");
    window.history.replaceState(null, "", url.pathname + url.search + url.hash);
  }, []);
  return message;
}

export function GoogleButton({ label = "Entrar com Google" }: { label?: string }) {
  const [available, setAvailable] = useState<boolean | null>(null);
  const message = useGoogleReturnMessage();

  useEffect(() => {
    let alive = true;
    fetch("/bff/auth/google/status", { cache: "no-store", credentials: "same-origin" })
      .then((r) => (r.ok ? r.json() : { available: false }))
      .then((j) => { if (alive) setAvailable(j?.available === true); })
      .catch(() => { if (alive) setAvailable(false); });
    return () => { alive = false; };
  }, []);

  return (
    <>
      {message && <p className="field__error" role="alert" data-testid="google-error">{message}</p>}
      {available === null ? (
        <span className="btn btn--secondary btn--block" aria-hidden style={{ visibility: "hidden" }}>{label}</span>
      ) : available ? (
        <a className="btn btn--secondary btn--block" href="/bff/auth/google/start" data-testid="google-login">
          <GoogleMark /> {label}
        </a>
      ) : (
        <UnavailableNote feature={label} reason="O login com Google não está configurado neste ambiente." />
      )}
    </>
  );
}

function GoogleMark() {
  return (
    <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden focusable="false" style={{ marginRight: 8 }}>
      <path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.8 2.4 30.3 0 24 0 14.6 0 6.6 5.4 2.6 13.2l7.9 6.1C12.4 13.7 17.7 9.5 24 9.5z"/>
      <path fill="#4285F4" d="M46.5 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.7c-.6 3-2.3 5.5-4.8 7.2l7.7 6c4.5-4.2 6.9-10.3 6.9-17.7z"/>
      <path fill="#FBBC05" d="M10.5 28.7c-.5-1.5-.8-3-.8-4.7s.3-3.2.8-4.7l-7.9-6.1C.9 16.5 0 20.1 0 24s.9 7.5 2.6 10.8l7.9-6.1z"/>
      <path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.7-6c-2.1 1.4-4.9 2.3-8.2 2.3-6.3 0-11.6-4.2-13.5-10l-7.9 6.1C6.6 42.6 14.6 48 24 48z"/>
    </svg>
  );
}
