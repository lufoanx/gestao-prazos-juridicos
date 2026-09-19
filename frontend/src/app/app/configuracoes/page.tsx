"use client";
import { Sliders, Bell, Info, RotateCcw } from "lucide-react";
import { useSettings } from "@/context/SettingsContext";
import { Select, Button, Badge, useToast } from "@/components/ui";

function Toggle({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string }) {
  return (
    <label style={{ display: "flex", gap: 10, alignItems: "flex-start", padding: "8px 0", cursor: "pointer" }}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} style={{ marginTop: 3 }} />
      <span>
        <span style={{ fontWeight: 600, color: "var(--text-strong)" }}>{label}</span>
        {hint ? <span style={{ display: "block", fontSize: "var(--fs-xs)", color: "var(--muted)" }}>{hint}</span> : null}
      </span>
    </label>
  );
}

export default function ConfiguracoesPage() {
  const { settings, update, reset } = useSettings();
  const toast = useToast();

  return (
    <div>
      <div className="page-head">
        <div className="page-head__title">
          <h1 style={{ fontSize: "var(--fs-2xl)", fontWeight: 700, color: "var(--text-strong)", margin: 0 }}>Configurações</h1>
          <p className="page-head__subtitle">Preferências de exibição e alertas · por usuário</p>
        </div>
        <div className="page-head__actions">
          <Button variant="secondary" onClick={() => { reset(); toast.info("Preferências restauradas"); }}><RotateCcw size={16} aria-hidden /> Restaurar padrão</Button>
        </div>
      </div>

      {/* Exibição — efeito real e imediato na interface */}
      <div className="form-card" style={{ maxWidth: 620 }}>
        <div className="card__head"><h2 className="card__title"><Sliders size={16} aria-hidden /> Exibição</h2><Badge tone="success">Efeito imediato</Badge></div>
        <div className="card__body">
          <div style={{ maxWidth: 280, marginBottom: 8 }}>
            <Select label="Densidade da interface" value={settings.density} onChange={(e) => update({ density: e.target.value as "comfortable" | "compact" })}>
              <option value="comfortable">Confortável</option>
              <option value="compact">Compacta</option>
            </Select>
          </div>
          <Toggle checked={settings.reduceMotion} onChange={(v) => update({ reduceMotion: v })}
            label="Reduzir animações" hint="Desliga transições e indicadores animados (acessibilidade)." />
          <Toggle checked={settings.showCompleted} onChange={(v) => update({ showCompleted: v })}
            label="Mostrar concluídos por padrão na lista de prazos" hint="Aplica-se ao abrir a lista de prazos." />
        </div>
      </div>

      {/* Alertas — DEMONSTRATIVOS (dependem de backend) */}
      <div className="form-card" style={{ maxWidth: 620, marginTop: 16 }}>
        <div className="card__head"><h2 className="card__title"><Bell size={16} aria-hidden /> Alertas de prazos</h2><Badge tone="neutral">Demonstrativo</Badge></div>
        <div className="card__body">
          <div className="form-note" style={{ marginBottom: 12 }}>
            <Info size={16} aria-hidden />
            <span>Estes alertas <strong>dependem de backend</strong> e não são enviados nesta demonstração. As escolhas ficam salvas por usuário.</span>
          </div>
          <Toggle checked={settings.emailAlerts} onChange={(v) => update({ emailAlerts: v })}
            label="Receber alertas por e-mail (demonstrativo)" />
          <div style={{ maxWidth: 280, margin: "8px 0" }}>
            <Select label="Resumo periódico (demonstrativo)" value={settings.digest} onChange={(e) => update({ digest: e.target.value as "daily" | "weekly" | "none" })}>
              <option value="none">Não enviar</option>
              <option value="daily">Diário</option>
              <option value="weekly">Semanal</option>
            </Select>
          </div>
          <div style={{ maxWidth: 280 }}>
            <Select label="Antecedência do alerta (dias, demonstrativo)" value={String(settings.soonAlertDays)} onChange={(e) => update({ soonAlertDays: parseInt(e.target.value, 10) })}>
              {[1, 2, 3, 5, 7].map((n) => <option key={n} value={n}>{n} dia(s)</option>)}
            </Select>
          </div>
        </div>
      </div>

      <p className="result-count" style={{ marginTop: 12 }}>As preferências são salvas automaticamente neste navegador, isoladas por conta.</p>
    </div>
  );
}
