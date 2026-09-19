"use client";
import { useState } from "react";
import { Info } from "lucide-react";
import { Input, Select, Button } from "@/components/ui";
import { getDemoToday } from "@/lib/clock.mjs";
import type { Deadline } from "@/types/domain";
import type { NewDeadlineInput } from "@/context/DataContext";

export const PRACTICE_AREAS = ["Cível", "Trabalhista", "Criminal", "Tributário", "Família", "Previdenciário", "Empresarial", "Outros"];

interface Candidate { id: string; name: string; }

interface DeadlineFormProps {
  initial?: Deadline;
  candidates?: Candidate[];   // responsáveis possíveis (escritório)
  submitLabel: string;
  onCancel: () => void;
  onSubmit: (input: NewDeadlineInput) => void;
}

export function DeadlineForm({ initial, candidates, submitLabel, onCancel, onSubmit }: DeadlineFormProps) {
  const today = getDemoToday();
  const [f, setF] = useState({
    title: initial?.title ?? "",
    caseNumber: initial?.caseNumber ?? "",
    court: initial?.court ?? "",
    practiceArea: initial?.practiceArea ?? PRACTICE_AREAS[0],
    responsibleId: initial?.responsibleId ?? (candidates?.[0]?.id ?? ""),
    priority: initial?.priority ?? "normal",
    startDate: initial?.startDate ?? today,
    dueDate: initial?.dueDate ?? "",
    countingMode: initial?.countingMode ?? "business",
    duration: String(initial?.duration ?? 0),
    agendaTime: initial?.agendaTime ?? "",
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setF((cur) => ({ ...cur, [k]: e.target.value }));

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const next: Record<string, string> = {};
    if (f.title.trim().length < 3) next.title = "Informe um título (mín. 3 caracteres).";
    if (f.caseNumber.trim().length < 3) next.caseNumber = "Informe o número do processo.";
    if (f.court.trim().length < 2) next.court = "Informe o tribunal/vara.";
    if (!f.dueDate) next.dueDate = "Informe a data de vencimento.";
    if (f.startDate && f.dueDate && f.dueDate < f.startDate) next.dueDate = "O vencimento não pode ser anterior ao início.";
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    onSubmit({
      title: f.title, caseNumber: f.caseNumber, court: f.court, practiceArea: f.practiceArea,
      responsibleId: f.responsibleId || undefined, priority: f.priority as "normal" | "high",
      startDate: f.startDate || today, dueDate: f.dueDate,
      countingMode: f.countingMode as "business" | "calendar",
      duration: Math.max(0, parseInt(f.duration || "0", 10) || 0),
      agendaTime: f.agendaTime || undefined,
    });
  }

  return (
    <form className="form-card" onSubmit={submit} noValidate>
      <div className="form-note" style={{ marginBottom: 16 }}>
        <Info size={16} aria-hidden />
        <span>A data de vencimento é informada por você. O PrazoAI <strong>não</strong> calcula prazos processuais oficiais; contagem e duração são apenas organizacionais.</span>
      </div>
      <div className="form-grid">
        <div className="col-span-2">
          <Input label="Título do prazo" required value={f.title} onChange={set("title")} error={errors.title} placeholder="Ex.: Contestação — ação de cobrança" />
        </div>
        <Input label="Número do processo" required value={f.caseNumber} onChange={set("caseNumber")} error={errors.caseNumber} placeholder="0000000-00.0000.0.00.0000" />
        <Input label="Tribunal / Vara" required value={f.court} onChange={set("court")} error={errors.court} placeholder="Ex.: TJSC · 2ª Vara Cível" />
        <Select label="Área de atuação" value={f.practiceArea} onChange={set("practiceArea")}>
          {PRACTICE_AREAS.map((a) => <option key={a} value={a}>{a}</option>)}
        </Select>
        <Select label="Prioridade" value={f.priority} onChange={set("priority")}>
          <option value="normal">Normal</option>
          <option value="high">Alta</option>
        </Select>
        <Input label="Início" type="date" value={f.startDate} onChange={set("startDate")} />
        <Input label="Vencimento" type="date" required value={f.dueDate} onChange={set("dueDate")} error={errors.dueDate} />
        <Select label="Contagem (organizacional)" value={f.countingMode} onChange={set("countingMode")}>
          <option value="business">Dias úteis</option>
          <option value="calendar">Dias corridos</option>
        </Select>
        <Input label="Duração (dias, referência)" type="number" min={0} value={f.duration} onChange={set("duration")} />
        <Input label="Horário na agenda (opcional)" type="time" value={f.agendaTime} onChange={set("agendaTime")} />
        {candidates && candidates.length > 1 ? (
          <Select label="Responsável" value={f.responsibleId} onChange={set("responsibleId")}>
            {candidates.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
        ) : null}
      </div>
      <div className="form-actions">
        <Button variant="secondary" onClick={onCancel}>Cancelar</Button>
        <Button type="submit" variant="primary">{submitLabel}</Button>
      </div>
    </form>
  );
}
