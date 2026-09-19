# Telas e fluxos
As rotas do índice são reservas técnicas. Implementar páginas dedicadas:
- /: landing, explicação do produto, benefícios verificáveis, demonstração visual, como funciona, autônomo/escritório, FAQ, links de entrar/criar conta. Sem avaliações, números ou promessas inventadas.
- /login: email, senha, mostrar senha, entrar, criar conta, esqueci senha, Google demonstrativo.
- /cadastro: nome, email, senha, confirmação; Google demonstrativo. Não pedir OAB logo de início.
- /esqueci-senha e /redefinir-senha/[token]: simular envio neutro, link demo explícito, estados expirado/inválido/sucesso.
- /onboarding: escolher autônomo, criar escritório ou ingressar.
- /onboarding/autonomo: preferências e área opcionais; /onboarding/escritorio: nome e configuração básica.
- /convite/[token]: identificar ambiente, confirmar ingresso, estados revogado/expirado/usado/segundo escritório.
- /solicitar-ingresso: referência inequívoca do escritório, confirmação pendente e resultado. Mecanismo de busca ainda pendente.
- /app/dashboard: urgentes primeiro, agenda do dia, intimações para revisão, visão geral. Números derivados dos mesmos registros das listas.
- /app/prazos: pesquisa, filtros status/urgência/responsável/área/período, ordenação, paginação, seleção e ações respeitando permissões.
- /app/prazos/novo: título, número de processo, tribunal/localidade, área, responsável, data de referência, duração, contagem, vencimento demonstrativo, prioridade, observações e anexos.
- /app/prazos/[id]: dados, comentários, anexos, histórico, editar, concluir, transferir quando permitido.
- /app/prazos/[id]/editar: formulário preenchido; confirmação de mudanças relevantes.
- /app/calendario: mês/semana/lista; clique abre prazo; filtros iguais à lista. Datas locais sem deslocamento UTC.
- /app/intimacoes: enviados, em processamento, aguardando revisão, revisados, falha.
- /app/intimacoes/upload: seletor/arrastar PDF, validação UI tipo/tamanho, progresso simulado, retry/cancelar.
- /app/intimacoes/[id]/revisao: PDF demonstrativo e campos sugeridos lado a lado; corrigir, confirmar explicitamente, só então criar prazo. Não confiar automaticamente na IA.
- /app/notificacoes: lidas/não lidas, marcar lida, abrir prazo, estados filtrados por ambiente.
- /app/perfil: dados pessoais, preferências; mudança de senha só demonstrativa.
- /app/configuracoes: alertas e preferências; vínculo ao escritório e saída com confirmação.
- /app/escritorio: dados e gestão autorizada.
- /app/escritorio/equipe: membros, cargo, áreas, permissões, atribuições.
- /app/escritorio/convites: gerar/copiar/revogar convite, solicitações pendentes e decisão.
- /app/escritorio/permissoes: cargo separado de permissões e área; visibilidade atribuídos/todos.
- Assistente: painel lateral acessível a partir do cabeçalho, rota /app/assistente como alternativa mobile.
Globais: 404, acesso não permitido, estado sem escritório, sessão demo encerrada, feedback de operação, alterações não salvas.
Fluxo-chave: landing > cadastro > onboarding > pessoal > convite > escritório > cadastrar prazo > voltar pessoal > verificar privacidade.

