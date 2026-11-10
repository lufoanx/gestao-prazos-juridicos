"use client";
// Convite integrado (6.2). O token vem SÓ do fragmento (#TOKEN): é capturado em memória, o
// fragmento é removido da barra imediatamente e o token só trafega no CORPO das requisições
// (consulta pública e aceite). Nada vai para pathname, query, redirect, logs ou storage.
// Se precisar autenticar, o fluxo continua nesta tela (login/cadastro embutidos).
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button, ConfirmDialog } from "@/components/ui";
import { INVITE_STATES, captureInviteToken } from "@/lib/integration/invite-token.mjs";
import type { InvitationLookup } from "@/lib/integration/dto.d.mts";
import { useAuth } from "./AuthProvider";
import { useOrg } from "./OrgProvider";
import { IntegratedLogin } from "./IntegratedLogin";
import { IntegratedSignup } from "./IntegratedSignup";
import { PublicFrame } from "./PublicFrame";
import { Notice, useMutation } from "./ui";
import { errorMessage } from "./messages";

type Lookup = { status: "loading" } | { status: "ready"; data: InvitationLookup } | { status: "error"; message: string };

export function IntegratedInvite() {
  const router = useRouter();
  const { state: auth } = useAuth();
  const { state: org, org: client, controller } = useOrg();
  const tokenRef = useRef<string | null>(null);
  const [captured, setCaptured] = useState<boolean | null>(null);
  const [lookup, setLookup] = useState<Lookup>({ status: "loading" });
  const [authTab, setAuthTab] = useState<"login" | "signup">("login");
  const [confirm, setConfirm] = useState(false);
  const accept = useMutation();

  useEffect(() => {
    tokenRef.current = captureInviteToken(window);         // lê e remove o fragmento da barra
    setCaptured(Boolean(tokenRef.current));
  }, []);

  useEffect(() => {
    if (!captured || !tokenRef.current) return;
    let alive = true;
    client.lookupInvitation(tokenRef.current)
      .then((data) => { if (alive) setLookup({ status: "ready", data }); })
      .catch((e) => { if (alive) setLookup({ status: "error", message: errorMessage(e) }); });
    return () => { alive = false; };
  }, [captured, client]);

  if (captured === null) return <PublicFrame title="Convite"><p aria-busy="true">Lendo convite…</p></PublicFrame>;
  if (!captured) {
    return (
      <PublicFrame title="Convite inválido">
        <p>Abra o link completo recebido (ele termina com <code>#</code> seguido do código do convite).</p>
      </PublicFrame>
    );
  }
  if (lookup.status === "loading") return <PublicFrame title="Convite"><p aria-busy="true">Verificando convite…</p></PublicFrame>;
  if (lookup.status === "error") return <PublicFrame title="Convite"><Notice kind="error">{lookup.message}</Notice></PublicFrame>;

  const { state, officeName } = lookup.data;
  if (state !== "valid") {
    return <PublicFrame title="Convite indisponível"><p role="status">{INVITE_STATES[state] ?? INVITE_STATES.invalid}</p></PublicFrame>;
  }

  async function doAccept() {
    setConfirm(false);
    const token = tokenRef.current;
    if (!token) return;
    const r = await accept.run(() => client.acceptInvitation(token));
    if (r.ok) {
      tokenRef.current = null;                                  // descarta o token da memória
      await controller.changed({ preferOffice: true }).catch(() => {});
      router.push("/app/escritorio");
      return;
    }
    if (r.code?.startsWith("invitation_")) {
      const s = r.code.replace("invitation_", "") as InvitationLookup["state"];
      setLookup({ status: "ready", data: { state: s in INVITE_STATES ? s : "invalid" } });
    }
    if (r.code === "already_in_office") await controller.revalidate();
  }

  return (
    <PublicFrame title="Convite para escritório" subtitle={officeName ? `Escritório: ${officeName}` : undefined}>
      <p role="status">{INVITE_STATES.valid}.</p>
      {auth.status !== "authenticated" ? (
        <>
          <p>Entre ou crie sua conta para aceitar. O convite continua nesta tela.</p>
          <div role="tablist" style={{ display: "flex", gap: 8, marginBottom: 12 }}>
            <Button variant={authTab === "login" ? "primary" : "secondary"} size="sm" role="tab" aria-selected={authTab === "login"} onClick={() => setAuthTab("login")}>Entrar</Button>
            <Button variant={authTab === "signup" ? "primary" : "secondary"} size="sm" role="tab" aria-selected={authTab === "signup"} onClick={() => setAuthTab("signup")}>Criar conta</Button>
          </div>
          {authTab === "login" ? <IntegratedLogin embedded onSuccess={() => {}} /> : <IntegratedSignup embedded onSuccess={() => {}} />}
        </>
      ) : org.status !== "ready" ? (
        <p aria-busy="true">Carregando seu vínculo…</p>
      ) : org.office ? (
        <Notice kind="error">Você já pertence ao escritório “{org.office.name}”. Cada pessoa pode pertencer a apenas um escritório; saia do atual para aceitar este convite.</Notice>
      ) : (
        <>
          <p>Você entrará com as permissões padrão de membro. Seus dados pessoais não são transferidos para o escritório.</p>
          {accept.error ? <Notice kind="error">{accept.error}</Notice> : null}
          <Button onClick={() => setConfirm(true)} disabled={accept.busy}>{accept.busy ? "Aceitando…" : "Aceitar convite"}</Button>
        </>
      )}
      <ConfirmDialog open={confirm} title="Aceitar convite?" confirmLabel="Aceitar e entrar"
        message={`Você entrará no escritório${officeName ? ` “${officeName}”` : ""}. Solicitações pendentes para outros escritórios serão canceladas.`}
        onCancel={() => setConfirm(false)} onConfirm={doAccept} />
    </PublicFrame>
  );
}

export function OldInviteLink() {
  return (
    <PublicFrame title="Link de convite em formato antigo">
      <p>Este link usa um formato que não é mais aceito. Peça a quem administra o escritório um novo link de convite.</p>
    </PublicFrame>
  );
}

