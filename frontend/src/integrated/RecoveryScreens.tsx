"use client";
// Telas integradas da recuperação de senha (E5) — só apresentação. Estado e efeitos em
// useRecoveryFlows.ts; regras em src/lib/integration/recovery-*.mjs. Nada aqui recebe o token:
// ele fica fora da renderização (nunca no DOM, em atributos ou mensagens).
import { useEffect, useRef, type ReactNode } from "react";
import Link from "next/link";
import { CheckCircle2, Info, MailCheck, ShieldAlert } from "lucide-react";
import { AuthShell } from "@/components/public/AuthShell";
import { PasswordInput } from "@/components/public/PasswordInput";
import { Button, Input } from "@/components/ui";
import { PASSWORD_MAX, PASSWORD_MIN } from "@/lib/integration/recovery-rules.mjs";
import { RECOVERY_TEXT, rateLimitText } from "@/lib/integration/recovery-flow.mjs";
import { useForgotFlow, useResetFlow } from "./useRecoveryFlows";

/** Leva o foco ao título quando a fase muda (leitores de tela anunciam o novo estado). */
function useFocusOnPhase(phase: string, ref: React.RefObject<HTMLDivElement | null>, skip: readonly string[]) {
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    if (!skip.includes(phase)) ref.current?.focus();
  }, [phase, ref, skip]);
}

function StateBox({ kind, children }: { kind: "ok" | "warn"; children: ReactNode }) {
  return (
    <div className={`state-box state-box--${kind}`} role={kind === "warn" ? "alert" : "status"}>
      {kind === "ok" ? <CheckCircle2 size={20} aria-hidden /> : <ShieldAlert size={20} aria-hidden />}
      <span>{children}</span>
    </div>
  );
}

function BackToLogin() {
  return <p className="auth__alt"><Link href="/login">Voltar para entrar</Link></p>;
}

/** Região focável que envolve o conteúdo de cada fase (sem saltos: mesma moldura em todas). */
function Phase({ focusRef, label, children }: { focusRef: React.RefObject<HTMLDivElement | null>; label: string; children: ReactNode }) {
  return <div ref={focusRef} tabIndex={-1} aria-label={label} style={{ outline: "none" }}>{children}</div>;
}

const FORGOT_TITLE: Record<string, string> = {
  checking: "Recuperar senha", disabled: "Recuperação indisponível", status_error: "Recuperar senha", form: "Recuperar senha",
  sending: "Recuperar senha", accepted: "Verifique seu e-mail", rate_limited: "Muitas solicitações", unknown: "Pedido não confirmado",
};
const NO_FOCUS_FORM = ["form", "sending"] as const;

// -------------------------------------------------------------------------------- /esqueci-senha
export function IntegratedForgotPassword() {
  const { state, email, setEmail, submit, check, edit } = useForgotFlow();
  const region = useRef<HTMLDivElement>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  useFocusOnPhase(state.phase, region, NO_FOCUS_FORM);
  useEffect(() => { if (state.phase === "form" && state.field === "email") emailRef.current?.focus(); }, [state]);
  const sending = state.phase === "sending";

  let body: ReactNode;
  switch (state.phase) {
    case "checking":
      body = <p aria-busy="true" role="status">Verificando disponibilidade…</p>;
      break;
    case "disabled":
      body = <><StateBox kind="warn">{RECOVERY_TEXT.disabled}</StateBox><BackToLogin /></>;
      break;
    case "status_error":
      body = (
        <>
          <StateBox kind="warn">{RECOVERY_TEXT.statusError}</StateBox>
          <Button variant="secondary" block onClick={check} style={{ marginTop: 16 }}>Verificar novamente</Button>
          <BackToLogin />
        </>
      );
      break;
    case "accepted":
      body = (
        <>
          <div className="state-box state-box--ok" role="status">
            <MailCheck size={20} aria-hidden />
            <span>{RECOVERY_TEXT.accepted}</span>
          </div>
          <p className="text-muted" style={{ marginTop: 12 }}>{RECOVERY_TEXT.acceptedNote}</p>
          <Button variant="secondary" block onClick={edit} style={{ marginTop: 8 }}>Fazer outro pedido</Button>
          <BackToLogin />
        </>
      );
      break;
    case "rate_limited":
      body = (
        <>
          <StateBox kind="warn">{rateLimitText(state.retryAfter)}</StateBox>
          <Button variant="secondary" block onClick={edit} disabled={state.waiting} style={{ marginTop: 16 }}>
            {state.waiting ? "Aguarde para tentar novamente" : "Tentar novamente"}
          </Button>
          <BackToLogin />
        </>
      );
      break;
    case "unknown":
      body = (
        <>
          <StateBox kind="warn">{RECOVERY_TEXT.forgotUnknown}</StateBox>
          <Button variant="secondary" block onClick={edit} style={{ marginTop: 16 }}>Voltar ao formulário</Button>
          <BackToLogin />
        </>
      );
      break;
    default:                                                     // form | sending
      body = (
        <>
          <form className="auth__form" noValidate aria-label="Pedir link de redefinição"
            onSubmit={(e) => { e.preventDefault(); void submit(); }}>
            <Input ref={emailRef} label="E-mail" type="email" autoComplete="email" required value={email}
              onChange={(e) => setEmail(e.target.value)} disabled={sending}
              error={state.field === "email" ? state.error : undefined} placeholder="voce@exemplo.com.br" />
            {state.error && state.field !== "email" ? <p className="field__error" role="alert">{state.error}</p> : null}
            <Button type="submit" variant="primary" block disabled={sending} aria-busy={sending || undefined}>
              {sending ? "Enviando…" : "Enviar link"}
            </Button>
          </form>
          <BackToLogin />
        </>
      );
  }

  return (
    <AuthShell title={FORGOT_TITLE[state.phase]} subtitle={state.phase === "form" || sending ? "Enviaremos um link para redefinir sua senha, se houver uma conta com o e-mail informado." : undefined}>
      <Phase focusRef={region} label={FORGOT_TITLE[state.phase]}>{body}</Phase>
    </AuthShell>
  );
}

// ----------------------------------------------------------------------------- /redefinir-senha
const RESET_TITLE: Record<string, string> = {
  reading: "Redefinir senha", missing: "Link incompleto", form: "Redefinir senha", sending: "Redefinir senha",
  success: "Senha redefinida", invalid_link: "Link inválido", rate_limited: "Muitas tentativas", unknown: "Resultado não confirmado",
};

export function IntegratedResetPassword() {
  const { state, password, setPassword, confirm, setConfirm, submit, edit } = useResetFlow();
  const region = useRef<HTMLDivElement>(null);
  const pwRef = useRef<HTMLInputElement>(null);
  const confirmRef = useRef<HTMLInputElement>(null);
  useFocusOnPhase(state.phase, region, NO_FOCUS_FORM);
  useEffect(() => {
    if (state.phase !== "form") return;
    if (state.field === "password") pwRef.current?.focus();
    if (state.field === "confirm") confirmRef.current?.focus();
  }, [state]);
  const sending = state.phase === "sending";

  let body: ReactNode;
  switch (state.phase) {
    case "reading":
      body = <p aria-busy="true" role="status">Lendo o link…</p>;
      break;
    case "missing":
      body = (
        <>
          <StateBox kind="warn">{RECOVERY_TEXT.missingLink}</StateBox>
          <Link className="btn btn--primary btn--block" href="/esqueci-senha" style={{ marginTop: 16 }}>Pedir novo link</Link>
          <BackToLogin />
        </>
      );
      break;
    case "success":
      body = (
        <>
          <StateBox kind="ok">{RECOVERY_TEXT.success}</StateBox>
          <Link className="btn btn--primary btn--block" href="/login" style={{ marginTop: 16 }}>Ir para o login</Link>
        </>
      );
      break;
    case "invalid_link":
      body = (
        <>
          <StateBox kind="warn">{RECOVERY_TEXT.invalidLink}</StateBox>
          <Link className="btn btn--primary btn--block" href="/esqueci-senha" style={{ marginTop: 16 }}>Pedir novo link</Link>
          <BackToLogin />
        </>
      );
      break;
    case "rate_limited":
      body = (
        <>
          <StateBox kind="warn">{rateLimitText(state.retryAfter)}</StateBox>
          <p className="text-muted" style={{ marginTop: 12 }}>{RECOVERY_TEXT.memoryOnly}</p>
          <Button variant="secondary" block onClick={edit} disabled={state.waiting} style={{ marginTop: 8 }}>
            {state.waiting ? "Aguarde para tentar novamente" : "Tentar novamente"}
          </Button>
        </>
      );
      break;
    case "unknown":
      body = (
        <>
          <StateBox kind="warn">{RECOVERY_TEXT.resetUnknown}</StateBox>
          <Link className="btn btn--primary btn--block" href="/login" style={{ marginTop: 16 }}>Conferir entrando com a nova senha</Link>
          <p className="text-muted" style={{ marginTop: 12 }}>{RECOVERY_TEXT.memoryOnly}</p>
          <Button variant="secondary" block onClick={edit} style={{ marginTop: 8 }}>Voltar ao formulário</Button>
        </>
      );
      break;
    default:                                                     // form | sending
      body = (
        <>
          <div className="form-note">
            <Info size={16} aria-hidden />
            <span>{RECOVERY_TEXT.memoryOnly}</span>
          </div>
          <form className="auth__form" noValidate aria-label="Definir nova senha"
            onSubmit={(e) => { e.preventDefault(); void submit(); }}>
            <PasswordInput ref={pwRef} label="Nova senha" autoComplete="new-password" required value={password}
              onChange={(e) => setPassword(e.target.value)} disabled={sending}
              error={state.field === "password" ? state.error : undefined}
              hint={`Entre ${PASSWORD_MIN} e ${PASSWORD_MAX} caracteres.`} />
            <PasswordInput ref={confirmRef} label="Confirmar nova senha" autoComplete="new-password" required value={confirm}
              onChange={(e) => setConfirm(e.target.value)} disabled={sending}
              error={state.field === "confirm" ? state.error : undefined} />
            {state.error && !state.field ? <p className="field__error" role="alert">{state.error}</p> : null}
            <Button type="submit" variant="primary" block disabled={sending} aria-busy={sending || undefined}>
              {sending ? "Redefinindo…" : "Redefinir senha"}
            </Button>
          </form>
          <BackToLogin />
        </>
      );
  }

  return (
    <AuthShell title={RESET_TITLE[state.phase]} subtitle={state.phase === "form" || sending ? "Escolha uma nova senha para sua conta." : undefined}>
      <Phase focusRef={region} label={RESET_TITLE[state.phase]}>{body}</Phase>
    </AuthShell>
  );
}
