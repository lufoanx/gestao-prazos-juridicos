# 01 — Auditoria Técnica

> Etapa 1 (fundação do backend, sem banco). Documento descritivo do estado atual.
> Não altera frontend nem copia regras para o backend.

## Estado atual do frontend
- **Stack:** React + Next.js 15 (App Router) + TypeScript + CSS puro (sem Tailwind).
- **Situação:** protótipo **navegável e concluído**, 100% demonstrativo (sem servidor).
- **Rotas (26 páginas + 404):** `/`, `/login`, `/cadastro`, `/esqueci-senha`,
  `/redefinir-senha/[token]`, `/onboarding`, `/onboarding/autonomo`,
  `/onboarding/escritorio`, `/convite/[token]`, `/solicitar-ingresso`,
  `/app`, `/app/dashboard`, `/app/prazos`, `/app/prazos/novo`, `/app/prazos/[id]`,
  `/app/prazos/[id]/editar`, `/app/calendario`, `/app/intimacoes`,
  `/app/intimacoes/upload`, `/app/intimacoes/[id]/revisao`, `/app/notificacoes`,
  `/app/escritorio`, `/app/escritorio/equipe`, `/app/perfil`, `/app/configuracoes`,
  `/app/assistente`, `/_not-found`.
- **Públicas:** landing, login, cadastro, recuperação/redefinição de senha, onboarding,
  convite e solicitação de ingresso. **Privadas:** tudo sob `/app`.

## Estado atual do backend
- **Antes desta etapa:** stub FastAPI com `app/main.py` (rotas `/` e `/calcular-prazo`)
  e `app/services/prazo_service.py` (cálculo de dias úteis demonstrativo). `requirements.txt`:
  `fastapi`, `uvicorn`.
- **Depois desta etapa (fundação):** FastAPI estruturado (config, health, CORS, base
  versionada `/api/v1`, erros, logs, OpenAPI em dev, testes). **Sem banco de dados / ORM.**
  Endpoints legados preservados; `/api/health` mantido como alias legado.

## Funcionalidades já navegáveis (demonstrativas)
Autenticação/onboarding simulados; dashboard; prazos (lista com busca/filtros/paginação/
ordenação, CRUD, conclusão/cancelamento/reabertura, comentários, anexos demonstrativos,
histórico); calendário; intimações (upload, processamento simulado, revisão obrigatória,
criação de 1 prazo vinculado); notificações; escritório/equipe (cargos, permissões,
visibilidade, convites, solicitações, transferência de admin, saída, transferência de
prazo pessoal→escritório); perfil; configurações; assistente simulado.

## Dados que ainda são simulados
Tudo. Não há servidor nem banco. Persistência via `localStorage`:
- `prazoai:demo-session` — sessão da conta (sem senha).
- `prazoai:demo-data:v1` — prazos, comentários, anexos, histórico, notificações, intimações.
- `prazoai:demo-org:v1` — escritórios, equipe, convites, solicitações (compartilhado entre contas no mesmo navegador).
- `prazoai:demo-settings:v1` — preferências por usuário.
- `prazoai:demo-assistant:v1` — conversas do assistente (por usuário e ambiente).

## Contextos (React) existentes
- `SessionContext` — sessão demonstrativa (usuário/escritório/perfil/preferências), hidratação e persistência; nunca guarda senha.
- `ScopeContext` — ambiente ativo (pessoal/escritório); deriva vínculo do roster compartilhado (fonte da verdade).
- `DataContext` — prazos/comentários/anexos/histórico/notificações/intimações + operações.
- `OrgContext` — registro compartilhado de escritórios/equipe/convites/solicitações (independente da sessão).
- `SettingsContext` — preferências por usuário.
- `useTeamActions` — coordenação de remoção+reatribuição de membros.

## Regras de negócio localizadas (fonte canônica)
Toda a lógica pura está em `frontend/src/lib/*.mjs` (com tipos `*.d.mts`):
- `access.mjs` — leitura/gestão de prazos (`canReadDeadline`, `canManageDeadline`).
- `deadline-guards.mjs` — guardas de operação e de intimação (`canWriteDeadline`, `canPerformOp`, `canAccessIntimation`, `OP_PERMISSION`).
- `data-ops.mjs` — operações de prazos/intimações/notificações/transferência/reatribuição (puras).
- `org-ops.mjs` — escritório único, último admin, sem auto-escalada, convites, solicitações, transferência de admin, saída (puras).
- `team-ops.mjs` — remoção coordenada com reatribuição.
- `urgency.mjs`, `dates.mjs`, `clock.mjs`, `dashboard.mjs`, `deadlines-view.mjs` — urgência (classificação visual, **não** cálculo oficial), datas civis, relógio demo, agregação do dashboard, filtros/calendário.
- `session.mjs` — transições de sessão + validação/restauração; `ids.mjs` — ids próprios (FNV-1a) evitando mistura de contas; `data-sanitize.mjs` — validação/migração dos dados locais; `settings.mjs` — preferências; `assistant.mjs` — respostas simuladas; `search.mjs` — href da busca global.

Observação: a **fonte canônica atual das regras é o frontend** (`src/lib/*.mjs`). O backend
**não** deve duplicá-las nesta etapa; a reimplementação canônica no servidor será planejada
nas próximas etapas (ver 02 e 03).

## Regras de isolamento, permissões e escritório (resumo)
- Isolamento Pessoal/Escritório por `scope` (ownerId vs officeId) aplicado em leitura e escrita.
- Permissões: `deadline.read/create/edit/complete/transfer`, `team.manage`, `office.manage`.
- Visibilidade de membro: `all` (todos os prazos) ou `assigned` (somente atribuídos).
- Escritório único por pessoa; nunca ficar sem administrador; sem auto-escalada de permissões.
- Intimações seguem isolamento + permissão + visibilidade; o autor do envio acompanha o item em processamento.

## Testes existentes (frontend) — 16 arquivos, 158 testes
`access`, `contracts`, `dashboard-summary`, `data-guards`, `data-ops`, `data-sanitize`,
`dates`, `deadlines-view`, `ids`, `intimations-ops`, `org-ops`, `session`, `stage6`,
`stage7`, `team-ops`, `urgency` (runner nativo `node --test`). ESLint configurado
(`eslint.config.mjs`, `npm run lint`).

## Riscos técnicos
- **Dupla fonte de verdade futura:** regras hoje no frontend; ao criar o backend, risco de
  divergência. Mitigação (próximas etapas): backend torna-se a fonte canônica e o frontend
  consome a API.
- **`.mjs` sem checagem TS completa:** tipos públicos em `.d.mts`; `checkJs` global geraria
  centenas de erros `implicit any` sob `strict`. Mitigado por `tests/contracts.test.mjs`.
- **Isolamento apenas no cliente:** hoje é de UI/estado; a autorização definitiva caberá ao backend.

## Dívidas técnicas
- Converter `.mjs`→`.ts` (ou reimplementar no backend) para checagem de tipos de ponta a ponta.
- `next lint` será descontinuado no Next 16 (migrar para ESLint CLI).

## Dependências relevantes
- Frontend: `next@15.5.25`, `react`, `typescript`, `eslint`/`eslint-config-next` (dev).
- Backend (fundação): `fastapi`, `uvicorn[standard]`, `pydantic-settings`; dev: `pytest`, `httpx`, `ruff`, `mypy`. **Nenhum banco/ORM.**

## Arquivos que serão substituídos/alterados na integração real (futuro)
- `frontend/src/context/*` (persistência local → chamadas à API).
- `frontend/src/lib/*-ops.mjs`, `access.mjs`, `deadline-guards.mjs`, `org-ops.mjs`,
  `team-ops.mjs`, `data-sanitize.mjs` (regras migram para o servidor; cliente só consome).
- `frontend/src/mocks/*` (sementes → dados reais).
- `localStorage` como armazenamento primário (passa a cache/estado efêmero).
