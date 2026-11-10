"use client";
// Onboarding integrado (6.2): ambiente pessoal (sempre existe) ou criação de escritório.
// "Autônomo" não é entidade no backend; entrar em escritório não transfere dados pessoais.
import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button, Input } from "@/components/ui";
import { useAuth } from "./AuthProvider";
import { useOrg } from "./OrgProvider";
import { PublicFrame } from "./PublicFrame";
import { Card, Notice, useMutation } from "./ui";

export function IntegratedOnboarding() {
  const router = useRouter();
  const { state: auth } = useAuth();
  const { state: org, org: client, controller } = useOrg();
  const [form, setForm] = useState({ name: "", roleLabel: "Administrador", areas: "" });
  const [fieldError, setFieldError] = useState<string | null>(null);
  const m = useMutation();

  if (auth.status === "loading") return <PublicFrame title="Começar"><p aria-busy="true">Carregando…</p></PublicFrame>;
  if (auth.status !== "authenticated") {
    return (
      <PublicFrame title="Começar">
        <p>Entre na sua conta para configurar seu ambiente.</p>
        <p><Link href="/login">Entrar</Link> · <Link href="/cadastro">Criar conta</Link></p>
      </PublicFrame>
    );
  }
  if (org.status === "loading" || org.status === "idle") return <PublicFrame title="Começar"><p aria-busy="true">Carregando vínculo…</p></PublicFrame>;
  if (org.status === "unavailable" || org.status === "error") {
    return (
      <PublicFrame title="Começar">
        <Notice kind="error">Não foi possível consultar seu vínculo agora. Nenhuma ação foi feita.</Notice>
        <Button variant="secondary" onClick={() => void controller.revalidate()}>Tentar novamente</Button>
      </PublicFrame>
    );
  }
  if (org.office) {
    return (
      <PublicFrame title="Você já pertence a um escritório" subtitle={org.office.name}>
        <p>Cada pessoa pertence a no máximo um escritório. Para criar ou entrar em outro, saia do atual primeiro.</p>
        <p><Link href="/app/escritorio">Ver escritório</Link></p>
      </PublicFrame>
    );
  }

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setFieldError(null);
    const name = form.name.trim();
    if (name.length < 2) { setFieldError("Informe o nome do escritório (mínimo 2 caracteres)."); return; }
    const practiceAreas = form.areas.split(",").map((a) => a.trim()).filter(Boolean);
    const r = await m.run(() => client.createOffice({ name, roleLabel: form.roleLabel.trim() || "Administrador", practiceAreas }));
    if (r.ok) {
      await controller.changed({ preferOffice: true }).catch(() => {});
      router.push("/app/escritorio");
    } else if (r.code === "already_in_office") {
      await controller.revalidate();                     // segundo escritório bloqueado pelo servidor
    }
  }

  return (
    <PublicFrame title="Como você quer começar?" subtitle="Você pode mudar depois.">
      <Card title="Ambiente pessoal">
        <p className="text-muted">Sempre disponível e só seu. Não exige escritório.</p>
        <Button variant="secondary" onClick={() => { controller.selectScope("personal"); router.push("/app"); }}>
          Usar ambiente pessoal
        </Button>
      </Card>
      <Card title="Criar escritório">
        <form onSubmit={create} noValidate aria-label="Criar escritório">
          <Input label="Nome do escritório" required value={form.name} error={fieldError ?? undefined}
            onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <Input label="Seu cargo (rótulo visual)" value={form.roleLabel} hint="O cargo não define permissões."
            onChange={(e) => setForm({ ...form, roleLabel: e.target.value })} />
          <Input label="Suas áreas de atuação (separadas por vírgula)" value={form.areas}
            onChange={(e) => setForm({ ...form, areas: e.target.value })} />
          {m.error ? <Notice kind="error">{m.error}</Notice> : null}
          <Button type="submit" disabled={m.busy}>{m.busy ? "Criando…" : "Criar escritório"}</Button>
        </form>
      </Card>
      <Card title="Entrar em um escritório existente">
        <p><Link href="/solicitar-ingresso">Solicitar ingresso com código</Link></p>
        <p className="text-muted">Recebeu um convite? Abra o link enviado por quem administra o escritório.</p>
      </Card>
    </PublicFrame>
  );
}
