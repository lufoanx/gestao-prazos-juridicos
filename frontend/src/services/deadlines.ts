import { demoDeadlines } from "@/mocks/data";
import type { Deadline, Scope } from "@/types/domain";

export interface DeadlineService {
  list(scope: Scope): Promise<Deadline[]>;
  get(id: string, scope: Scope): Promise<Deadline | undefined>;
}

function sameScope(a: Scope, b: Scope) {
  return a.kind === b.kind && (
    a.kind === "personal" && b.kind === "personal" ? a.ownerId === b.ownerId :
    a.kind === "office" && b.kind === "office" && a.officeId === b.officeId
  );
}

export const mockDeadlineService: DeadlineService = {
  async list(scope) { return structuredClone(demoDeadlines.filter((d) => sameScope(d.scope, scope))); },
  async get(id, scope) { return (await this.list(scope)).find((d) => d.id === id); },
};

// Serviço-semente somente leitura. As etapas seguintes adicionam CRUD demonstrativo
// com persistência local validada. O filtro por ambiente NÃO substitui autorização
// de servidor — é apenas recorte de dados no cliente.
