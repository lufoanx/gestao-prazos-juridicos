export interface AssistantMessage { role:"user"|"assistant"; content:string; }
export interface AssistantService { reply(messages:AssistantMessage[]):Promise<AssistantMessage>; }
export const mockAssistantService:AssistantService={async reply(){return {role:"assistant",content:"Modo demonstrativo: posso orientar sobre cadastro, revisão e organização dos prazos. Não há modelo de IA conectado e não calculo vencimentos oficiais."};}};

