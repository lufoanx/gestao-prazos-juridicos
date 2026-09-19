// Assistente DEMONSTRATIVO — respostas SIMULADAS por palavras-chave.
// NÃO há IA real, NÃO oferece orientação jurídica nem cálculo processual oficial.
// Foco exclusivo: organização de prazos e uso da PrazoAI. Quando usa números,
// eles vêm do ambiente ATIVO já filtrado por escopo/permissões (ctx), calculados
// pela camada de dados — este módulo só formata a resposta.

export const DISCLAIMER =
  "Assistente demonstrativo: respostas simuladas, sem IA real. Não oferece orientação jurídica nem cálculo de prazos processuais oficiais.";

export const SUGGESTIONS = [
  "Quantos prazos eu tenho em aberto?",
  "O que vence nos próximos dias?",
  "Tenho algo vencido?",
  "Como cadastro um novo prazo?",
  "Como funciona a revisão de intimações?",
  "Como transfiro um prazo para o escritório?",
];

const has = (q, ...terms) => terms.some((t) => q.includes(t));

/**
 * @param {string} question
 * @param {{ open:number, overdue:number, dueSoon:number, reviews:number, scopeLabel:string }} ctx
 * @returns {string}
 */
export function generateAnswer(question, ctx) {
  const q = String(question || "").toLowerCase().trim();
  const amb = ctx.scopeLabel ? ` no ambiente ${ctx.scopeLabel}` : "";

  if (!q) return "Escolha uma sugestão ou digite uma pergunta sobre organização de prazos.";

  if (has(q, "vencid", "atrasad", "venceu")) {
    return ctx.overdue > 0
      ? `Você tem ${ctx.overdue} prazo(s) vencido(s)${amb}. Abra "Prazos" e filtre por urgência "Vencidos" para priorizá-los. (Contagem visual — não é cálculo processual oficial.)`
      : `Nenhum prazo vencido${amb}. Continue acompanhando os próximos vencimentos pelo dashboard.`;
  }
  if (has(q, "próxim", "proxim", "vence", "semana", "hoje", "amanhã", "amanha")) {
    return ctx.dueSoon > 0
      ? `Há ${ctx.dueSoon} prazo(s) vencendo em breve${amb}. Veja o bloco "Urgentes" no dashboard ou o filtro "Próximos" na lista.`
      : `Não há prazos próximos do vencimento${amb} agora.`;
  }
  if (has(q, "aberto", "quantos", "pendente", "total")) {
    return `Você tem ${ctx.open} prazo(s) em aberto${amb}. Use a lista de "Prazos" para buscar, filtrar e ordenar.`;
  }
  if (has(q, "cadastr", "novo prazo", "criar", "adicionar")) {
    return 'Para cadastrar: menu "Prazos" → "Novo prazo". Preencha título, processo, tribunal, área, datas e responsável. A data de vencimento é informada por você (não há cálculo oficial).';
  }
  if (has(q, "intima", "revis", "pdf", "upload")) {
    return ctx.reviews > 0
      ? `Há ${ctx.reviews} intimação(ões) aguardando revisão${amb}. Em "Intimações", envie o PDF (processamento simulado), confira os dados sugeridos e confirme para criar um único prazo vinculado.`
      : 'Em "Intimações" você envia um PDF (processamento simulado), revisa os dados sugeridos e confirma para gerar o prazo. Os dados não são extraídos do arquivo — exigem conferência humana.';
  }
  if (has(q, "transfer", "escritório", "escritorio", "compartilh")) {
    return "Para compartilhar um prazo pessoal com o escritório: abra o prazo e use \"Transferir ao escritório\". O mesmo registro, comentários, anexos e histórico são preservados.";
  }
  if (has(q, "notific", "alerta", "aviso")) {
    return 'Notificações do ambiente atual ficam no sino do cabeçalho e em "Notificações". Alertas por e-mail/digest são demonstrativos (dependem de backend) e ficam em "Configurações".';
  }
  if (has(q, "equipe", "membro", "permiss", "convite", "solicit")) {
    return 'Gestão de equipe fica em "Equipe" (requer permissão): cargos, áreas, permissões, convites e solicitações de ingresso.';
  }
  if (has(q, "ajuda", "como usar", "o que", "consegue", "pode")) {
    return "Posso ajudar a se organizar na PrazoAI: contar prazos em aberto, próximos e vencidos, e explicar como cadastrar prazos, revisar intimações, transferir ao escritório e configurar alertas. " + DISCLAIMER;
  }
  return "Sou um assistente demonstrativo focado em organização de prazos e uso da PrazoAI. Tente perguntar sobre prazos em aberto, próximos vencimentos, cadastro de prazos ou revisão de intimações. " + DISCLAIMER;
}
