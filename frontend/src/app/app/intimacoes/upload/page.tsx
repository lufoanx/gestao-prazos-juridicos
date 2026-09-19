"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { UploadCloud, FileText, X, Loader2, CheckCircle2, AlertTriangle, ShieldAlert } from "lucide-react";
import { useScope } from "@/context/ScopeContext";
import { useData } from "@/context/DataContext";
import { canManageDeadline } from "@/lib/access.mjs";
import { Breadcrumb, Button, EmptyState, useToast } from "@/components/ui";

const MAX_BYTES = 10 * 1024 * 1024; // 10 MB
type Phase = "select" | "processing" | "success" | "error";

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function UploadIntimacaoPage() {
  const router = useRouter();
  const { scopeKind, membership } = useScope();
  const { uploadIntimation, retryIntimation, getIntimation } = useData();
  const toast = useToast();
  const inputRef = useRef<HTMLInputElement>(null);

  const canUpload = canManageDeadline(scopeKind, membership, "deadline.create");
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string>();
  const [over, setOver] = useState(false);
  const [phase, setPhase] = useState<Phase>("select");
  const [intimationId, setIntimationId] = useState<string | null>(null);
  const [simulateFail, setSimulateFail] = useState(false);

  // Reage ao processador central: quando a intimação sai de "processing",
  // reflete sucesso/erro — funciona mesmo após recarregar (o processador resolve).
  const current = intimationId ? getIntimation(intimationId) : undefined;
  const currentStatus = current?.status;
  useEffect(() => {
    if (!intimationId) return;
    if (currentStatus === "awaiting_review" || currentStatus === "reviewed") setPhase("success");
    else if (currentStatus === "failed") setPhase("error");
    else if (currentStatus === "processing") setPhase("processing");
  }, [intimationId, currentStatus]);

  if (!canUpload) {
    return (
      <div>
        <Breadcrumb items={[{ label: "Intimações", href: "/app/intimacoes" }, { label: "Enviar" }]} />
        <div className="card"><div className="card__body">
          <EmptyState icon={<ShieldAlert size={30} aria-hidden />} title="Sem permissão">
            Seu perfil neste ambiente não permite enviar intimações.
          </EmptyState>
        </div></div>
      </div>
    );
  }

  function validate(f: File): string | undefined {
    const isPdf = f.type === "application/pdf" || f.name.toLowerCase().endsWith(".pdf");
    if (!isPdf) return "Formato inválido: envie um arquivo PDF.";
    if (f.size > MAX_BYTES) return `Arquivo muito grande (máx. ${formatSize(MAX_BYTES)}).`;
    if (f.size === 0) return "Arquivo vazio.";
    return undefined;
  }
  function accept(f: File | undefined) {
    if (!f) return;
    const err = validate(f);
    if (err) { setError(err); setFile(null); return; }
    setError(undefined); setFile(f);
  }
  function onDrop(e: React.DragEvent) {
    e.preventDefault(); setOver(false);
    accept(e.dataTransfer.files?.[0]);
  }
  function clearFile() { setFile(null); setError(undefined); if (inputRef.current) inputRef.current.value = ""; }

  function send() {
    if (!file) return;
    const id = uploadIntimation({ name: file.name, demoForceFail: simulateFail });
    if (!id) { toast.error("Não foi possível enviar", "Sem permissão neste ambiente."); return; }
    setIntimationId(id);
    setPhase("processing");
    // O processamento (simulado) é resolvido pelo processador central da casca —
    // continua mesmo se você navegar ou recarregar a página.
  }
  function retry() {
    if (!intimationId) return;
    retryIntimation(intimationId); // falha → processing; o processador central reprocessa até sucesso
    setPhase("processing");
  }

  return (
    <div>
      <Breadcrumb items={[{ label: "Intimações", href: "/app/intimacoes" }, { label: "Enviar PDF" }]} />
      <div className="page-head">
        <div className="page-head__title">
          <h1 style={{ fontSize: "var(--fs-2xl)", fontWeight: 700, color: "var(--text-strong)", margin: 0 }}>Enviar intimação (PDF)</h1>
          <p className="page-head__subtitle">{scopeKind === "office" ? "Escritório" : "Ambiente pessoal"}</p>
        </div>
      </div>

      <div className="review-banner">
        <AlertTriangle size={18} aria-hidden />
        <span>O processamento é <strong>simulado</strong>: nenhum PDF é lido, não há IA/OCR nem envio de e-mail. Os dados sugeridos <strong>não derivam do arquivo</strong> e passarão por revisão humana obrigatória antes de virar prazo.</span>
      </div>

      <div className="form-card">
        {phase === "select" && (
          <>
            <div
              className={`dropzone${over ? " dropzone--over" : ""}`}
              onDragOver={(e) => { e.preventDefault(); setOver(true); }}
              onDragLeave={() => setOver(false)}
              onDrop={onDrop}
              onClick={() => inputRef.current?.click()}
              role="button" tabIndex={0}
              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); inputRef.current?.click(); } }}
              aria-label="Selecionar ou arrastar um PDF"
            >
              <div className="dropzone__icon"><UploadCloud size={34} aria-hidden /></div>
              <div style={{ fontWeight: 600, color: "var(--text-strong)" }}>Arraste um PDF aqui ou clique para selecionar</div>
              <div className="dropzone__hint">Somente PDF · até {formatSize(MAX_BYTES)}</div>
              <input ref={inputRef} type="file" accept="application/pdf,.pdf" hidden
                onChange={(e) => accept(e.target.files?.[0])} />
            </div>
            {error ? <p className="field__error" style={{ marginTop: 10 }}>{error}</p> : null}

            {file ? (
              <div className="filechip" style={{ marginTop: 16 }}>
                <span className="filechip__icon"><FileText size={20} aria-hidden /></span>
                <span className="filechip__main">
                  <span className="filechip__name">{file.name}</span>
                  <span className="filechip__meta">{formatSize(file.size)}</span>
                </span>
                <button className="icon-btn" aria-label="Remover arquivo" onClick={clearFile}><X size={16} aria-hidden /></button>
              </div>
            ) : null}

            <label style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 16, fontSize: "var(--fs-sm)", color: "var(--muted)" }}>
              <input type="checkbox" checked={simulateFail} onChange={(e) => setSimulateFail(e.target.checked)} />
              Simular falha no processamento (para testar nova tentativa)
            </label>

            <div className="form-actions">
              <Button variant="secondary" onClick={() => router.push("/app/intimacoes")}>Cancelar</Button>
              <Button variant="primary" onClick={send} disabled={!file}>Enviar para processamento</Button>
            </div>
          </>
        )}

        {phase === "processing" && (
          <div className="proc-state proc-state--processing">
            <Loader2 size={18} className="spin" aria-hidden />
            <span>Processando (simulado)… nenhum dado é extraído do arquivo.</span>
          </div>
        )}

        {phase === "success" && (
          <>
            <div className="proc-state proc-state--success">
              <CheckCircle2 size={18} aria-hidden />
              <span>Processamento concluído. Revise os dados sugeridos antes de criar o prazo.</span>
            </div>
            <div className="form-actions">
              <Button variant="secondary" onClick={() => router.push("/app/intimacoes")}>Ver intimações</Button>
              <Button variant="primary" onClick={() => intimationId && router.push(`/app/intimacoes/${intimationId}/revisao`)}>Revisar agora</Button>
            </div>
          </>
        )}

        {phase === "error" && (
          <>
            <div className="proc-state proc-state--error">
              <AlertTriangle size={18} aria-hidden />
              <span>Falha no processamento (simulada). Você pode tentar novamente.</span>
            </div>
            <div className="form-actions">
              <Button variant="secondary" onClick={() => router.push("/app/intimacoes")}>Ver intimações</Button>
              <Button variant="primary" onClick={retry}>Tentar novamente</Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
