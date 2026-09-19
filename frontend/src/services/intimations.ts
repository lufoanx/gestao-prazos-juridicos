import { demoIntimations } from "@/mocks/data";
import type { Intimation, Scope } from "@/types/domain";

function sameScope(a: Scope, b: Scope) {
  return a.kind === b.kind && (
    a.kind === "personal" && b.kind === "personal" ? a.ownerId === b.ownerId :
    a.kind === "office" && b.kind === "office" && a.officeId === b.officeId
  );
}

export interface IntimationService {
  list(scope: Scope): Promise<Intimation[]>;
}

// Somente leitura nesta etapa. Upload, processamento e revisão obrigatória são
// SIMULADOS nas etapas seguintes — nunca há extração real de PDF nem IA real.
export const mockIntimationService: IntimationService = {
  async list(scope) { return structuredClone(demoIntimations.filter((i) => sameScope(i.scope, scope))); },
};
