# PrazoAI — Frontend (protótipo navegável)

Interface web do **PrazoAI**, plataforma de **gestão de prazos jurídicos**. Este
diretório contém o **protótipo de frontend** — totalmente navegável e
**100% demonstrativo**: não há backend, banco de dados, IA, OCR, envio de e-mail
nem cálculo processual oficial. Todos os dados são simulados e persistidos apenas
no navegador (localStorage).

> **Root Directory na Vercel:** `frontend`

## Stack
React + Next.js 15 (App Router) · TypeScript · CSS puro (sem Tailwind) · testes com o runner nativo do Node.

## Requisitos
- Node.js 20+ (desenvolvido em Node 22)
- npm 10+

## Instalação e execução
```bash
cd frontend
npm install
npm run dev
# abre em http://localhost:3000
```

Build de produção e execução:
```bash
npm run build
npm start
```

## Verificações (todas devem passar)
```bash
npm test        # testes das regras puras (runner nativo do Node)
npm run typecheck  # tsc --noEmit
npm run build      # build de produção do Next.js
```

## Credenciais demonstrativas
**Não há senhas.** A autenticação é simulada: em `/login` ou `/cadastro` use
**qualquer nome e e-mail** (ex.: `voce@exemplo.com`). O e-mail identifica a “conta”
demonstrativa e ancora o isolamento de dados no navegador. **Nenhuma senha é
digitada, enviada ou armazenada.**

Para explorar sem se cadastrar, acesse `/app/dashboard` diretamente — uma persona
semeada é usada apenas na visita direta.

## Funcionalidades (demonstrativas)
- **Landing, autenticação e onboarding** simulados (autônomo ou escritório).
- **Dashboard** com urgências, agenda e visão geral por ambiente.
- **Prazos**: lista com busca, filtros (status/urgência/área), paginação e ordenação; cadastro, edição, detalhes, conclusão/cancelamento/reabertura; comentários; **anexos demonstrativos**; histórico.
- **Calendário** mensal com navegação e cores por urgência/status.
- **Intimações**: upload de PDF com arrastar/soltar e validação, processamento **simulado** (não lê o arquivo), **revisão humana obrigatória** e criação de **um único** prazo vinculado (proteção contra duplicação).
- **Notificações** por ambiente, com marcar como lida (individual/todas) e contador sincronizado.
- **Escritório e equipe**: dados do escritório; membros com cargos, áreas, permissões e visibilidade (todos os prazos ou somente atribuídos); **convites por link único**; **solicitações de ingresso**; **transferência de administração**; **saída do escritório**; **transferência de prazo pessoal → escritório** preservando o mesmo registro.
- **Perfil**: editar nome e preferências (e-mail é âncora de identidade, somente leitura); “alterar senha” apenas simula.
- **Configurações** por usuário: densidade e redução de animações (efeito real), mostrar concluídos por padrão; alertas de e-mail/resumo claramente **demonstrativos**.
- **Assistente**: chat com respostas **simuladas** (sem IA real), focado em organização de prazos e uso da PrazoAI; respeita o ambiente ativo e as permissões.
- **Alternância Pessoal/Escritório** com **isolamento** de dados, aplicando permissões também na camada de dados.

## Persistência demonstrativa (localStorage)
- `prazoai:demo-session` — sessão da conta (sem senha).
- `prazoai:demo-data:v1` — prazos, comentários, anexos, histórico, notificações, intimações.
- `prazoai:demo-org:v1` — escritórios, equipe, convites e solicitações (compartilhado entre contas no mesmo navegador; não depende só da sessão).
- `prazoai:demo-settings:v1` — preferências por usuário.
- `prazoai:demo-assistant:v1` — conversas do assistente, isoladas por usuário e ambiente.

Para “zerar” a demonstração: limpe o armazenamento do site nas ferramentas do navegador.

## Limitações e o que dependerá do backend
Este protótipo **não** implementa nada do que segue — tudo está claramente rotulado como demonstrativo na interface:
- **Autenticação/segurança real**: sem senhas, sessões de servidor, tokens, recuperação de senha, RBAC no servidor, auditoria confiável ou HTTPS/headers de segurança.
- **Banco de dados e sincronização**: os dados vivem no navegador; não há persistência de servidor nem sincronização entre dispositivos/usuários.
- **IA / OCR / leitura de PDF**: o “processamento” de intimações é simulado e os dados sugeridos **não** vêm do arquivo.
- **Cálculo de prazos processuais oficial**: as datas são informadas manualmente; urgência é apenas classificação visual.
- **Envio de e-mail / notificações push / integrações** (tribunais, Google, etc.).
- **Upload real de arquivos**: anexos são fictícios (nenhum arquivo é enviado/armazenado).
- **Isolamento real por servidor**: o isolamento aqui é de UI/estado no navegador; a autorização definitiva caberá ao backend.

## Estrutura
```
frontend/
  src/app/            # rotas (App Router)
  src/components/      # UI, casca (shell), públicos, prazos, marca
  src/context/        # sessão, escopo, dados, escritório, configurações
  src/lib/            # regras puras (datas, urgência, acesso, ops, assistente…) + tipos .d.mts
  src/mocks/          # dados semeados
  tests/              # testes das regras puras (node --test)
```

## Observações
- Sem Tailwind: estilos em `src/app/globals.css` com design tokens.
- Acessibilidade: navegação por teclado, foco visível, `skip link`, rótulos, `aria-live` no assistente e respeito a `prefers-reduced-motion`.
- Não commitar `node_modules/`, `.next/`, caches ou `.env*` (ver `.gitignore`).
