# PrazoAI — Backend (sem banco de dados)

API do PrazoAI em **FastAPI (Python)**. Expõe `GET /api/v1/health` (com `GET /api/health`
apenas como alias legado), os endpoints legados preservados, **autenticação e perfil**
(Etapa 2: `/api/v1/auth/*`, `/api/v1/users/me`) e **escritórios, equipe, permissões,
convites e solicitações** (Etapa 3: `/api/v1/offices/*`, `/api/v1/memberships/me`,
`/api/v1/invitations/*`, `/api/v1/join-requests/*`) e **prazos, comentários, histórico,
calendário e transferência** (Etapa 4: `/api/v1/deadlines/*`, `/api/v1/calendar`) e
**intimações (metadados + revisão humana) e notificações internas** (Etapa 5:
`/api/v1/intimations/*`, `/api/v1/notifications/*`), tudo com armazenamento **em memória**.
**Não há banco de dados, ORM, armazenamento de arquivos, processamento/IA, envio de e-mail nem
integração com o frontend** — as telas continuam demonstrativas.

> **Stack oficial: Python/FastAPI.** Decisão do projeto é preservar o backend
> Python existente; não há migração para NestJS. Ver
> `docs/backend/02-arquitetura-proposta.md`.

## Requisitos
- Python 3.11+ (desenvolvido em 3.12)

## Instalação (ambiente isolado, reproduzível)
```bash
cd backend
make install        # cria .venv e instala requirements-dev.txt
```
Sem Makefile:
```bash
cd backend
python3 -m venv .venv
.venv/bin/pip install -U pip
.venv/bin/pip install -r requirements-dev.txt
```

## Execução
```bash
make dev            # uvicorn app.main:app --reload --port 8000
# ou
.venv/bin/uvicorn app.main:app --reload --port 8000
```

## Windows (PowerShell)
Equivalentes dos comandos acima, executados a partir da pasta `backend`:
```powershell
# criação e ativação do venv
py -3 -m venv .venv
.\.venv\Scripts\Activate.ps1
# (se a execução de scripts estiver bloqueada, rode uma vez:)
# Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass

# instalação
python -m pip install --upgrade pip
pip install -r requirements-dev.txt

# execução
uvicorn app.main:app --reload --port 8000

# verificações
pytest
ruff check app tests
mypy app
python -m compileall app
```
No Windows, use os comandos acima diretamente (o `make` normalmente não está disponível).

## Verificações (equivalentes a test/lint/typecheck/build)
> Backend em Python não usa `package.json`/`npm`. Os alvos abaixo são os
> equivalentes reais e são executáveis.
```bash
make test        # pytest
make lint        # ruff check app tests
make typecheck   # mypy app
make build       # python -m compileall app (valida compilação; sem artefato)
```

## Endpoint de saúde (versionado)
Contrato canônico:
```
GET /api/v1/health  ->  200
{ "status": "ok", "service": "prazoai-backend" }
```
Alias **legado** de compatibilidade (mesmo corpo): `GET /api/health` — o contrato
oficial é `/api/v1/health`.

## Autenticação (Etapa 2 — em memória)
> ⚠️ **Não é produção.** Usuários, sessões e tokens ficam na memória do processo: são
> **perdidos ao reiniciar** e **não funcionam com múltiplos workers** (rode com um só).
> Com `ENVIRONMENT=production` e `AUTH_ENABLED=true`, a aplicação **não inicia**.

| Método e rota | Auth | Resposta |
|---|---|---|
| `POST /api/v1/auth/register` `{name,email,password}` | não | 201 usuário público (não autentica) |
| `POST /api/v1/auth/login` `{email,password}` | não | 200 `{accessToken,refreshToken,tokenType,expiresIn,user}` |
| `POST /api/v1/auth/refresh` `{refreshToken}` | não | 200 novo par (rotação; reutilização revoga a sessão) |
| `POST /api/v1/auth/logout` | sim | 204 (revoga a sessão atual) |
| `GET /api/v1/auth/me` | sim | 200 `{user}` |
| `GET /api/v1/users/me` | sim | 200 usuário público |
| `PATCH /api/v1/users/me` `{name}` | sim | 200 usuário público |
| `POST /api/v1/auth/forgot-password` `{email}` | não | 202 mensagem genérica (sem envio real de e-mail) |
| `POST /api/v1/auth/reset-password` `{token,newPassword}` | não | 204 (revoga todas as sessões) |

Senha: Argon2id, 8–128 caracteres, sem truncamento. Access token: JWT HS256 de 15 min,
validado também contra a sessão no servidor e a versão da credencial (sessões anteriores a
uma redefinição deixam de valer). Limites (429 + `Retry-After`, verificados antes de
qualquer Argon2): login 5 tentativas por IP+e-mail em 5 min; recuperação 3 pedidos por
e-mail em 15 min; cadastro 10 por IP por hora; redefinição 10 por IP em 15 min. No máximo
10 sessões por usuário, 1000 rotações de refresh por sessão (depois, novo login) e um
token de recuperação ativo por usuário.
Detalhes, decisões e limitações: `docs/backend/06-etapa-2-autenticacao.md`; contratos:
`docs/backend/04-contratos-api-iniciais.md`.

## Escritórios e equipe (Etapa 3 — em memória)
> ⚠️ Mesmas ressalvas da Etapa 2 (memória, um worker, bloqueado em production — inclusive
> com `AUTH_ENABLED=false` se `OFFICES_ENABLED=true`). Desde a Etapa 4, remoção de membro e
> saída reatribuem os prazos em aberto (`reassignTo`) numa única transação.

- Criar escritório cria o vínculo administrativo do criador; no máximo um vínculo por pessoa.
- Matriz de autorização: só administrador (`office.manage`) concede/retira `team.manage` e
  `office.manage`; gestor (`team.manage`) só delega o que tem e não altera outros gestores;
  ninguém amplia o próprio acesso; sempre ≥ 1 administrador; cargo não concede poderes.
- Autorização relida no servidor a cada requisição (redução vale imediatamente).
- Convite = link portador de uso único (7 dias), só hash guardado; token no corpo de
  `POST /api/v1/invitations/lookup|accept`. Convidar e aprovar solicitações exigem
  `team.manage` **e** todas as permissões concedidas no ingresso (`deadline.read`,
  `create`, `edit`, `complete`).
- Código de ingresso aleatório (10 caracteres) só permite **solicitar**; aprovação por gestor.
- Outro escritório ou recurso inexistente → 404 `not_found`.

Detalhes, matriz completa, exemplos e limites: `docs/backend/07-etapa-3-escritorios-rbac.md`.

## Prazos (Etapa 4 — em memória)
- `POST|GET /api/v1/deadlines`, `GET|PATCH /api/v1/deadlines/{id}`, `POST .../status`,
  `POST .../transfer`, `GET|POST .../comments`, `GET .../history`, `GET /api/v1/calendar`.
- Pessoal: só o dono. Escritório: vínculo atual + `deadline.read` + (`all` ou responsável) e a
  permissão da operação; `assigned` só cria/atribui para si. Gestão de equipe não dá acesso.
- `version` obrigatório em `PATCH`/status/transferência (409 `version_conflict`).
- Vencimento informado pelo usuário; `duration`/`countingMode` são referências organizacionais
  (sem cálculo processual oficial). Urgência é visual, no fuso `DEADLINES_TIMEZONE`.
- Transações com escritas preparadas e rollback real; ordem de locks escritórios → prazos.

Detalhes, matriz, exemplos e limites: `docs/backend/08-etapa-4-prazos.md`.

## Intimações e notificações (Etapa 5 — em memória)
- Registro de **metadados declarados** (`file.storage = "not_stored"`); nenhum PDF é recebido,
  armazenado ou processado (`processing.status = "not_available"`).
- Rascunho com versão; **confirmação** exige `version` e todos os dados finais, cria exatamente
  um prazo (regras da Etapa 4) — 201 na primeira, 200 em repetição sem efeito.
- Descarte lógico com retenção; acesso da Issue #5 (responsável atual do prazo vinculado).
- Notificações individuais sem conteúdo armazenado, ocultas quando o acesso ao recurso se perde;
  política da caixa documentada em `retentionPolicy`.

Detalhes: `docs/backend/09-etapa-5-intimacoes-notificacoes.md`.

## Configuração (variáveis de ambiente)
Copie `.env.example` para `.env` (em desenvolvimento nenhum segredo é obrigatório; nunca versione o `.env`):
- `SERVICE_NAME` (padrão `prazoai-backend`)
- `ENVIRONMENT` (`development` habilita Swagger em `/docs`; `production` desabilita)
- `API_PREFIX` (padrão `/api`)
- `API_VERSION_PREFIX` (padrão `/v1`; base canônica = `API_PREFIX`+`API_VERSION_PREFIX` → `/api/v1`)
- `ENABLE_LEGACY_HEALTH_ALIAS` (padrão `true`; expõe `/api/health` como alias legado)
- `CORS_ORIGINS` (lista separada por vírgula; padrão `http://localhost:3000`). Em produção, liste origens explícitas; `"*"` é **descartado** porque `allow_credentials=True`.
- `LOG_LEVEL` (padrão `INFO`)
- `AUTH_ENABLED` (padrão `true`) e `AUTH_STORAGE` (`memory`, único valor nesta etapa; bloqueado em `production`)
- `AUTH_JWT_SECRET` (mín. 32 bytes; obrigatório em `staging`/`production`; vazio em `development`/`test` gera segredo aleatório por instância). Gere com `python -c "import secrets; print(secrets.token_urlsafe(64))"`
- `AUTH_JWT_ISSUER` / `AUTH_JWT_AUDIENCE` (padrões `prazoai-backend` / `prazoai-api`)
- `AUTH_ACCESS_TOKEN_TTL_SECONDS` (900), `AUTH_REFRESH_TOKEN_TTL_SECONDS` (604800, vida absoluta da sessão), `AUTH_PASSWORD_RESET_TTL_SECONDS` (1800)
- `AUTH_LOGIN_MAX_FAILURES` (5) / `AUTH_LOGIN_WINDOW_SECONDS` (300), `AUTH_FORGOT_MAX_REQUESTS` (3) / `AUTH_FORGOT_WINDOW_SECONDS` (900)
- `AUTH_REGISTER_MAX_REQUESTS` (10) / `AUTH_REGISTER_WINDOW_SECONDS` (3600), `AUTH_RESET_MAX_REQUESTS` (10) / `AUTH_RESET_WINDOW_SECONDS` (900)
- `AUTH_RATE_LIMIT_MAX_KEYS` (10000; chaves além do teto compartilham um balde de transbordo) e `AUTH_MAX_SESSIONS_PER_USER` (10)
- `INTIMATIONS_*` e `NOTIFICATIONS_*` (tetos e retenção — ver doc 09)
- `DEADLINES_TIMEZONE` (America/Sao_Paulo), `DEADLINES_SOON_DAYS` (3) e tetos `DEADLINES_MAX_*` — ver doc 08
- `OFFICES_ENABLED` (vazio = acompanha `AUTH_ENABLED`) e `ORG_*` (validade de convite, limites de taxa, tetos de pendências e retenção — ver doc 07)
- `AUTH_MAX_REFRESH_ROTATIONS_PER_SESSION` (1000, entre 10 e 100000): rotações de refresh por sessão; ao atingir o teto, o próximo refresh encerra a sessão (401 `session_rotation_limit_reached`)

## Observações
- **Sem banco/ORM**: nenhuma dependência de persistência foi instalada.
- **Sem segredos** no repositório; `.env` é ignorado pelo `.gitignore`.
- Endpoints legados `/` e `/calcular-prazo` foram **preservados** (o cálculo
  legado é demonstrativo, não é cálculo processual oficial).
- `/calcular-prazo` desconsidera sábados, domingos e **feriados nacionais**
  (Issue #2). Não contempla recesso forense, feriados estaduais/municipais nem
  calendários de tribunais — ver `docs/backend/05-calculo-de-prazos.md`.
- Swagger/OpenAPI em `/docs` e `/openapi.json` apenas fora de produção.
