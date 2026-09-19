"use client";
import { useEffect, useState } from "react";
import { UserCircle, Info, ShieldAlert } from "lucide-react";
import { useSession } from "@/context/SessionContext";
import { useScope } from "@/context/ScopeContext";
import { Input, Select, Button, EmptyState, Badge, useToast } from "@/components/ui";

const AREAS = ["", "Cível", "Trabalhista", "Criminal", "Tributário", "Família", "Previdenciário", "Empresarial", "Outros"];

export default function PerfilPage() {
  const { session, hydrated, updateProfile, updatePreferences } = useSession();
  const { user, scopeKind, membership } = useScope();
  const toast = useToast();

  const [name, setName] = useState(user.name);
  const [area, setArea] = useState(session.preferences.practiceArea ?? "");
  const [nameError, setNameError] = useState<string>();
  // Marca se o usuário já editou, para não sobrescrever com a sincronização.
  const [touched, setTouched] = useState(false);

  // Ao trocar de conta, volta a sincronizar os campos com a nova sessão.
  useEffect(() => { setTouched(false); }, [session.user?.id]);

  // Hidratação: ao abrir /app/perfil direto, os campos assumem a sessão SALVA
  // (não ficam presos aos dados da persona demonstrativa).
  useEffect(() => {
    if (!hydrated || touched) return;
    setName(session.user?.name ?? "");
    setArea(session.preferences.practiceArea ?? "");
  }, [hydrated, session.user?.id, session.user?.name, session.preferences.practiceArea, touched]);

  // Campos de "senha" são apenas demonstrativos — nada é armazenado.
  const [pwd, setPwd] = useState("");
  const [pwd2, setPwd2] = useState("");

  if (!session.user) {
    return (
      <div>
        <div className="page-head"><div className="page-head__title">
          <h1 style={{ fontSize: "var(--fs-2xl)", fontWeight: 700, color: "var(--text-strong)", margin: 0 }}>Perfil</h1>
        </div></div>
        <div className="card"><div className="card__body">
          <EmptyState icon={<UserCircle size={30} aria-hidden />} title="Sessão demonstrativa">
            Entre com uma conta para ver e editar o perfil.
          </EmptyState>
        </div></div>
      </div>
    );
  }

  function saveProfile(e: React.FormEvent) {
    e.preventDefault();
    if (name.trim().length < 2) { setNameError("Informe seu nome (mín. 2 caracteres)."); return; }
    setNameError(undefined);
    updateProfile({ name });
    updatePreferences({ practiceArea: area || undefined });
    toast.success("Perfil atualizado", "As alterações já aparecem no cabeçalho.");
  }

  function savePassword(e: React.FormEvent) {
    e.preventDefault();
    if (pwd.length < 6) { toast.error("Senha muito curta", "Use ao menos 6 caracteres (demonstrativo)."); return; }
    if (pwd !== pwd2) { toast.error("As senhas não conferem"); return; }
    setPwd(""); setPwd2("");
    toast.info("Alteração demonstrativa", "Nenhuma senha é armazenada nesta demonstração.");
  }

  return (
    <div>
      <div className="page-head">
        <div className="page-head__title">
          <h1 style={{ fontSize: "var(--fs-2xl)", fontWeight: 700, color: "var(--text-strong)", margin: 0 }}>Perfil</h1>
          <p className="page-head__subtitle">Dados pessoais e preferências</p>
        </div>
      </div>

      <div className="form-card" style={{ maxWidth: 560 }}>
        <form className="auth__form" onSubmit={saveProfile} noValidate>
          <Input label="Nome" required value={name} onChange={(e) => { setName(e.target.value); setTouched(true); }} error={nameError} />
          <Input label="E-mail" type="email" value={user.email} readOnly disabled
            hint="O e-mail identifica sua conta demonstrativa e não pode ser alterado aqui (evita misturar dados)." />
          <Select label="Área de atuação preferida" value={area} onChange={(e) => { setArea(e.target.value); setTouched(true); }}>
            {AREAS.map((a) => <option key={a || "none"} value={a}>{a || "Prefiro não informar"}</option>)}
          </Select>
          {scopeKind === "office" ? (
            <div className="form-note">
              <Info size={16} aria-hidden />
              <span>No escritório atual seu cargo é <strong>{membership?.roleLabel ?? "—"}</strong>. Cargo e permissões são geridos em Equipe.</span>
            </div>
          ) : null}
          <div className="form-actions">
            <Button type="submit" variant="primary">Salvar alterações</Button>
          </div>
        </form>
      </div>

      <div className="form-card" style={{ maxWidth: 560, marginTop: 16 }}>
        <div className="card__head"><h2 className="card__title">Alterar senha</h2><Badge tone="neutral">Demonstrativo</Badge></div>
        <div className="form-note" style={{ margin: "12px 0" }}>
          <ShieldAlert size={16} aria-hidden />
          <span>Esta demonstração <strong>não armazena senhas</strong>. O formulário abaixo apenas simula o fluxo.</span>
        </div>
        <form className="auth__form" onSubmit={savePassword} noValidate>
          <Input label="Nova senha" type="password" value={pwd} onChange={(e) => setPwd(e.target.value)} />
          <Input label="Confirmar nova senha" type="password" value={pwd2} onChange={(e) => setPwd2(e.target.value)} />
          <div className="form-actions">
            <Button type="submit" variant="secondary">Simular alteração</Button>
          </div>
        </form>
      </div>
    </div>
  );
}
