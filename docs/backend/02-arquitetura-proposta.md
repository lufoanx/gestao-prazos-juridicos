# 02 — Arquitetura Proposta

> Etapa 1. Define fronteiras e estratégia. **Sem banco, sem ORM, sem auth real** ainda.

## Decisão de stack (oficial)
**Stack oficial do backend: Python/FastAPI.** Já existe um backend FastAPI funcional
e a decisão do projeto é preservar o backend Python. **Não há migração para NestJS** —
a revisão da Etapa 1 confirmou a fundação FastAPI como decisão arquitetural.

A fundação atende a todos os requisitos: health versionado, config/env, CORS seguro,
prefixo `/api` + versão `/v1`, erros padronizados, validação de DTO via Pydantic, logs,
OpenAPI em dev, testes e scripts.

## Fronteiras Frontend ↔ Backend
- **Frontend (Next.js):** UI, navegação, estados de tela, validação de formulário
  (UX), consumo da API (futuro). Hoje usa `localStorage` como armazenamento demo.
- **Backend (FastAPI):** fonte canônica das regras de negócio (futuro), autorização,
  validação de dados, persistência (futuro), integrações (IA/e-mail) (futuro).
- **Contrato:** HTTP/JSON sob a base versionada `/api/v1` (ver 04). Nesta etapa, só `/api/v1/health` (com alias legado `/api/health`).

## Responsabilidades por camada (backend)
- **api/** — roteamento, DTOs de entrada/saída, códigos HTTP. Sem regra de negócio.
- **services/** (futuro) — regras de negócio (casos de uso). Fonte canônica.
- **domain/** (futuro, conceitual) — entidades e invariantes (ver 03).
- **repositories/** (futuro) — abstração de persistência (interface), implementação em
  memória primeiro e, depois, banco real (sem acoplar o domínio ao ORM).
- **core/** — configuração, logging, erros, segurança (futuro).

## Estrutura modular recomendada (evolução)
```
backend/app/
  core/         # config, logging, errors (ESTA ETAPA)
  api/          # routers + DTOs (health nesta etapa)
  domain/       # entidades/regras conceituais (próximas etapas)
  services/     # casos de uso (prazo_service legado preservado)
  repositories/ # interfaces + impl. em memória → banco (futuro)
  tests/
```

## Fluxo de autenticação
> **Etapa 2 implementada** em `/api/v1/auth` (em memória, Argon2id, JWT + refresh rotativo).
> Detalhes e diferenças em relação ao esboço abaixo: `06-etapa-2-autenticacao.md`.

Esboço original (Etapa 1):
1. `POST /api/auth/login` (e-mail/senha) → emite token (JWT de acesso + refresh).
2. Senhas com hash forte (ex.: bcrypt/argon2) — **nunca** em texto puro.
3. Middleware lê o token, injeta o usuário no request.
4. `POST /api/auth/refresh`, `POST /api/auth/logout`.
> O frontend demonstrativo não guarda senha; a sessão real substituirá o `SessionContext`.

## Fluxo futuro de autorização
- RBAC por `Membership`/permissões (as mesmas do frontend: `deadline.*`, `team.manage`,
  `office.manage`) + visibilidade (`all`/`assigned`).
- Guardas no servidor espelham as guardas puras do frontend (`access`, `deadline-guards`,
  `org-ops`) — que passam a ser a referência a reimplementar no backend.
- Isolamento Pessoal/Escritório aplicado em TODA consulta/mutação (não confiar no cliente).

## Estratégia de validação
- **Entrada:** DTOs Pydantic (validação automática → 422 padronizado).
- **Domínio:** invariantes nos serviços (ex.: escritório único, último admin).

## Estratégia de tratamento de erros
- Handler global com corpo `{ "error": { "code", "message", "details?" } }`.
- **Nunca** stack trace, caminhos do servidor ou dados sensíveis. 500 genérico.

## Estratégia de logs
- `logging` padrão; nível por `LOG_LEVEL`. Loga método/caminho/status/código de erro.
- **Nunca** corpos, cabeçalhos de auth, tokens ou segredos.

## Estratégia futura de banco de dados (SEM instalar agora)
- Camada de **repositório** com interface estável; implementação inicial **em memória**
  para testes e, depois, um banco relacional (ex.: PostgreSQL) com migrations versionadas.
- O domínio não depende do ORM; o ORM fica confinado à implementação do repositório.
- Decisão de ORM/banco fica para a etapa específica (com confirmação do orientador).

## Estratégia futura para anexos, notificações e IA
- **Anexos:** upload para armazenamento de objetos (ex.: S3-compatível) + metadados no banco;
  hoje são demonstrativos (nenhum arquivo é enviado).
- **Notificações:** persistidas e entregues via API; e-mail/push dependem de provedor externo
  (fora do escopo do protótipo).
- **IA/OCR:** serviço isolado que recebe o PDF e devolve sugestões; a revisão humana
  obrigatória permanece. Hoje a extração é **simulada** e não lê o arquivo.

## Decisões arquiteturais e justificativas
- **FastAPI preservado** (compatível com a decisão do projeto e com o backend existente).
- **Versionamento real `/api/v1`** (prefixo `/api` + versão `/v1`) separando de endpoints legados; `/api/health` é alias legado.
- **Repositório antes de ORM** para não acoplar domínio à persistência.
- **Erros/logs sem vazamento** por requisito de segurança.
- **OpenAPI só em dev** para não expor superfície em produção.
