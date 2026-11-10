"use client";
import Link from "next/link";
import { useAuth } from "./AuthProvider";
import { useOrg } from "./OrgProvider";
import { Card, PageHead } from "./ui";

export function IntegratedHome() {
  const { state } = useAuth();
  const { state: org } = useOrg();
  return (
    <div>
      <PageHead title={`Olá, ${state.user?.name ?? ""}`} />
      {org.status === "loading" || org.status === "idle" ? <p aria-busy="true">Carregando vínculo…</p> : null}
      {org.status === "ready" && org.scope === "office" && org.office ? (
        <Card title={`Ambiente do escritório: ${org.office.name}`}>
          <p>Seu cargo exibido: <strong>{org.membership?.roleLabel}</strong> (rótulo visual; não define permissões).</p>
          <p><Link href="/app/escritorio">Ver escritório</Link> · <Link href="/app/escritorio/equipe">Ver equipe</Link></p>
        </Card>
      ) : null}
      {org.status === "ready" && org.scope === "personal" ? (
        <Card title="Ambiente pessoal">
          <p>Seu ambiente pessoal sempre existe e é só seu. {org.office ? "Entrar em um escritório não transfere seus dados pessoais." : ""}</p>
        </Card>
      ) : null}
      {org.status === "ready" && !org.office ? (
        <Card title="Você ainda não pertence a um escritório">
          <p className="text-muted">Você pode continuar só no ambiente pessoal, criar um escritório ou entrar em um existente.</p>
          <p><Link href="/onboarding">Criar escritório</Link> · <Link href="/solicitar-ingresso">Entrar com código de ingresso</Link></p>
          <p className="text-muted">Recebeu um convite? Abra o link enviado por quem administra o escritório.</p>
        </Card>
      ) : null}
      <Card>
        <p className="text-muted">Prazos, calendário, intimações e notificações estão em integração e serão habilitados nas
          próximas entregas. Nenhum dado demonstrativo é exibido no modo integrado.</p>
      </Card>
    </div>
  );
}

export function NotIntegratedModule() {
  return (
    <div className="card"><div className="card__body" role="status">
      <h1 style={{ fontSize: "var(--fs-xl)" }}>Módulo ainda não integrado</h1>
      <p className="text-muted">Esta área será conectada ao servidor em uma próxima entrega. Para evitar confusão,
        nenhum dado demonstrativo é exibido aqui.</p>
    </div></div>
  );
}
