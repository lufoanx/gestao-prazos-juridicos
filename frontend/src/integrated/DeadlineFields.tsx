"use client";
// Campos do prazo (cadastro e edição) com as mesmas regras do backend (o servidor é a autoridade).
import { Input, Select } from "@/components/ui";
import { isCivilDate } from "@/lib/integration/civil-date.mjs";
import type { DeadlineInput } from "@/lib/integration/dto.d.mts";

export type DeadlineDraft = {
  title: string; caseNumber: string; court: string; practiceArea: string; responsibleId: string;
  priority: "normal" | "high"; startDate: string; dueDate: string; countingMode: "business" | "calendar";
  duration: string; agendaTime: string; reviewed: boolean;
};

export function emptyDraft(responsibleId: string): DeadlineDraft {
  return { title: "", caseNumber: "", court: "", practiceArea: "", responsibleId, priority: "normal", startDate: "", dueDate: "",
    countingMode: "business", duration: "", agendaTime: "", reviewed: true };
}

const len = (v: string, min: number, max: number) => { const n = v.trim().replace(/\s+/g, " ").length; return n >= min && n <= max; };

export function validateDraft(d: DeadlineDraft): Record<string, string> {
  const e: Record<string, string> = {};
  if (!len(d.title, 3, 200)) e.title = "Título: 3 a 200 caracteres.";
  if (!len(d.caseNumber, 3, 50)) e.caseNumber = "Processo: 3 a 50 caracteres.";
  if (!len(d.court, 2, 120)) e.court = "Tribunal/vara: 2 a 120 caracteres.";
  if (!len(d.practiceArea, 1, 60)) e.practiceArea = "Área: 1 a 60 caracteres.";
  if (!isCivilDate(d.startDate)) e.startDate = "Informe a data de início.";
  if (!isCivilDate(d.dueDate)) e.dueDate = "Informe o vencimento.";
  if (isCivilDate(d.startDate) && isCivilDate(d.dueDate) && d.dueDate < d.startDate) e.dueDate = "O vencimento não pode ser anterior ao início.";
  for (const k of ["startDate", "dueDate"] as const) if (isCivilDate(d[k]) && (d[k] < "2000-01-01" || d[k] > "2100-12-31")) e[k] = "Data fora do intervalo permitido.";
  const dur = Number(d.duration);
  if (!/^\d+$/.test(d.duration) || dur < 1 || dur > 3650) e.duration = "Duração: inteiro de 1 a 3650.";
  if (d.agendaTime && !/^([01]\d|2[0-3]):[0-5]\d$/.test(d.agendaTime)) e.agendaTime = "Horário no formato HH:MM.";
  if (!d.responsibleId) e.responsibleId = "Escolha o responsável.";
  return e;
}

export function draftToInput(d: DeadlineDraft): DeadlineInput {
  return {
    title: d.title.trim(), caseNumber: d.caseNumber.trim(), court: d.court.trim(), practiceArea: d.practiceArea.trim(),
    responsibleId: d.responsibleId, priority: d.priority, startDate: d.startDate, dueDate: d.dueDate,
    countingMode: d.countingMode, duration: Number(d.duration), agendaTime: d.agendaTime || null, reviewed: d.reviewed,
  };
}

export function DeadlineFields({ draft, onChange, errors, responsibles, lockResponsible, hideReviewed }: {
  draft: DeadlineDraft; onChange: (d: DeadlineDraft) => void; errors: Record<string, string>;
  responsibles: Array<{ userId: string; name: string }>; lockResponsible?: boolean;
  /** Confirmação de intimação: a revisão humana tem declaração própria e o servidor marca o prazo como revisado. */
  hideReviewed?: boolean;
}) {
  const set = <K extends keyof DeadlineDraft>(k: K) => (v: DeadlineDraft[K]) => onChange({ ...draft, [k]: v });
  return (
    <>
      <Input label="Título" required value={draft.title} error={errors.title} onChange={(e) => set("title")(e.target.value)} />
      <Input label="Número do processo" required value={draft.caseNumber} error={errors.caseNumber} onChange={(e) => set("caseNumber")(e.target.value)} />
      <Input label="Tribunal / vara" required value={draft.court} error={errors.court} onChange={(e) => set("court")(e.target.value)} />
      <Input label="Área de atuação" required value={draft.practiceArea} error={errors.practiceArea} onChange={(e) => set("practiceArea")(e.target.value)} />
      <Select label="Responsável" required value={draft.responsibleId} error={errors.responsibleId} disabled={lockResponsible}
        onChange={(e) => set("responsibleId")(e.target.value)}>
        {responsibles.map((r) => <option key={r.userId} value={r.userId}>{r.name}</option>)}
      </Select>
      <Select label="Prioridade" value={draft.priority} onChange={(e) => set("priority")(e.target.value as DeadlineDraft["priority"])}>
        <option value="normal">Normal</option><option value="high">Alta</option>
      </Select>
      <Input label="Início" type="date" required value={draft.startDate} error={errors.startDate} onChange={(e) => set("startDate")(e.target.value)} />
      <Input label="Vencimento" type="date" required value={draft.dueDate} error={errors.dueDate} onChange={(e) => set("dueDate")(e.target.value)}
        hint="Informado e revisado por você." />
      <Input label="Horário (opcional)" type="time" value={draft.agendaTime} error={errors.agendaTime} onChange={(e) => set("agendaTime")(e.target.value)} />
      <Select label="Forma de contagem (referência)" value={draft.countingMode} onChange={(e) => set("countingMode")(e.target.value as DeadlineDraft["countingMode"])}>
        <option value="business">Dias úteis</option><option value="calendar">Dias corridos</option>
      </Select>
      <Input label="Duração em dias (referência)" inputMode="numeric" required value={draft.duration} error={errors.duration} onChange={(e) => set("duration")(e.target.value)} />
      <p className="text-muted" style={{ fontSize: "var(--fs-sm)" }}>
        Duração e forma de contagem são referências organizacionais: o sistema não calcula o prazo processual
        oficial. O vencimento é o informado acima.
      </p>
      {hideReviewed ? null : (
        <label style={{ display: "block", margin: "8px 0" }}>
          <input type="checkbox" checked={draft.reviewed} onChange={(e) => set("reviewed")(e.target.checked)} />{" "}
          Conferi os dados (declaração sua; não é certificação jurídica)
        </label>
      )}
    </>
  );
}
