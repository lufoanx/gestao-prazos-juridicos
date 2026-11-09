# PrazoAI — Backend (sem banco de dados)

API do PrazoAI em **FastAPI (Python)**. Expõe `GET /api/v1/health` (com `GET /api/health`
apenas como alias legado), os endpoints legados preservados e, desde a **Etapa 2**,
**autenticação e perfil** (`/api/v1/auth/*`, `/api/v1/users/me`) com armazenamento
**em memória**. **Não há banco de dados, ORM, escritórios/RBAC, envio de e-mail nem
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
