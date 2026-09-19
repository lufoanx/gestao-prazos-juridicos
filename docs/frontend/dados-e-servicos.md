# Dados e serviços
Tipos iniciais: src/types/domain.ts; sementes: src/mocks/data.ts. Usar nomes e processos inteiramente fictícios, não extrair conteúdo dos prints.
Serviços atuais apenas leitura de prazo e resposta fixa do chat. Claude deverá adicionar CRUD demonstrativo, comentários, anexos locais fictícios, notificações e membros coerentes.
Persistência demo versionada em localStorage para dados não sensíveis, inicializada no cliente, com validação ao ler, reset e opção de alternar cenários. Não armazenar senhas/tokens reais/PDFs sensíveis.
Simular login com conta pré-definida ou cadastro somente em memória, explicitamente sem autenticação real. Google deve ter diálogo 'integração demonstrativa', nunca fingir OAuth.
Datas YYYY-MM-DD como datas civis; usar relógio demonstrativo controlável para exemplos não ficarem obsoletos. Contadores devem usar mesmos registros.
PDF: gerar amostra fictícia legível ou preview seguro; processamento simulado, nunca alegar extração real. Limites UI propostos devem constar como configuração demonstrativa, sem validar segurança real de arquivo.
Chat: painel e mensagens, perguntas sugeridas, loading/error/retry, limite UI, aviso modo demonstrativo. Respostas pré-definidas ou serviço mock, não IA real. Não diagnosticar direito, criar vencimentos oficiais nem alterar registros. Contexto só com dados acessíveis no ambiente atual.
API futura: manter serviços separados de componentes e contratos tipados; sem FastAPI real nesta fase. Posteriormente backend valida identidade, vínculo, escopo, regras, uploads, rate limit e segredos.

