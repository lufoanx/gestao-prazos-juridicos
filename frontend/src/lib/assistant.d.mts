export const DISCLAIMER: string;
export const SUGGESTIONS: string[];
export interface AssistantContext {
  open: number;
  overdue: number;
  dueSoon: number;
  reviews: number;
  scopeLabel: string;
}
export function generateAnswer(question: string, ctx: AssistantContext): string;
