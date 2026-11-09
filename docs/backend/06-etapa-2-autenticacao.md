# 06 — Etapa 2: Autenticação e usuários em memória

> **Estado:** implementado no backend (FastAPI), com armazenamento **em memória**.
> **Não** há banco, escritórios/RBAC, e-mail real, login Google nem integração com o
> frontend. O frontend continua demonstrativo (sessão simulada no navegador).

## 1. Escopo entregue
`/api/v1/auth/register`, `/login`, `/refresh`, `/logout`, `/me`, `/forgot-password`,
`/reset-password`; `/api/v1/users/me` (GET/PATCH). Contratos detalhados em
`04-contratos-api-iniciais.md`.

Fora desta etapa: escritórios, equipe, convites, RBAC, CRUD de prazos/intimações,
PostgreSQL/ORM/migrations, IA/OCR, envio de e-mail, Google, integração com as telas,
preferências do usuário (o `PATCH /users/me` aceita só `name`).

## 2. Arquitetura
```
app/
  api/            auth.py, users.py (rotas) · deps.py (serviço da instância, usuário autenticado)
  schemas/        auth.py (DTOs camelCase, extra="forbid", validação de e-mail/nome/senha)
  services/       auth_service.py (casos de uso) · auth_container.py (composição por instância)
                  password_reset_delivery.py (interface de entrega + adaptador noop)
  repositories/   auth.py (interfaces Protocol) · memory.py (implementação em memória)
  security/       passwords.py (Argon2id) · tokens.py (JWT + tokens opacos) · rate_limit.py
  domain/         auth.py (User, AuthSession, PasswordResetToken)
  core/           config.py (variáveis AUTH_*) · clock.py (relógio injetável) · errors.py (AppError)
```
- **Estado por instância:** `create_app()` monta um `AuthContainer` novo em `app.state.auth`
  (repositórios, limitadores, relógio e segredo efêmero). Nada mutável fica em variáveis
  globais; duas instâncias não compartilham usuários nem sessões (há teste).
- **Injeção:** `create_app(clock=..., password_reset_delivery=..., password_hasher=...)`.
  Os testes usam relógio controlável e um adaptador que captura a mensagem de recuperação.
- **Interfaces de repositório** (`UserRepository`, `SessionRepository`,
  `PasswordResetRepository`) definem as garantias que a futura persistência deve manter
  (unicidade, rotação e consumo atômicos). SQLAlchemy **não** foi instalado.
- **Alias legado:** `/api/health` agora inclui **somente** o módulo de saúde; não existe
  `/api/auth/*` nem `/api/users/*` (há teste).

## 3. Decisões
| Tema | Decisão |
|---|---|
| Hash de senha | Argon2id via `argon2-cffi` (parâmetros padrão RFC 9106); rehash automático no login se os parâmetros mudarem |
| Access token | JWT HS256 via `PyJWT`; valida algoritmo explícito, assinatura, `exp`, `iat`, `iss`, `aud`, `typ="access"`, `sub`, `sid`, `jti`. `exp`/`iat` conferidos com o relógio injetado |
| Sessão no servidor | Todo access token carrega `sid`; a dependência confere se a sessão existe, não foi revogada, pertence ao usuário e não expirou. Logout/reset valem **na hora** |
| Refresh token | Opaco (`secrets.token_urlsafe`), só o SHA-256 é guardado. Gira a cada uso; o anterior é invalidado no mesmo lock. Reutilização de um token já girado **revoga a família (sessão)** |
| Vida da sessão | `AUTH_REFRESH_TOKEN_TTL_SECONDS` é a vida **absoluta** da sessão; a rotação não estende |
| Recuperação | Token opaco de uso único, só hash guardado, validade `AUTH_PASSWORD_RESET_TTL_SECONDS`. Novo pedido invalida os pendentes. Resposta 202 genérica idêntica |
| Redefinição | Consome o token atomicamente, troca o hash, invalida tokens pendentes e revoga **todas** as sessões. Não autentica (204) |
| E-mail | Validado com `email-validator` (sem checagem DNS), sem espaços externos e em minúsculas; único |
| Senha | 8 a 128 caracteres, não pode ser só espaços; **sem truncamento** nem alteração |
| Nome | Espaços colapsados, 1 a 120 caracteres, sem caracteres de controle |
| Campos extras | DTOs com `extra="forbid"`: `role`, `permissions`, `officeId`, `id`, `email` (no PATCH) etc. → 422 |
| Usuário inexistente no login | Executa uma verificação Argon2 sobre hash fictício (custo equivalente) e devolve o mesmo 401 genérico |
| Segredo JWT | Sem padrão no código. Obrigatório em staging/production (mín. 32 bytes, placeholders recusados). Em development/test, se ausente, gera-se um segredo aleatório **por instância** |
| Produção | `AUTH_STORAGE=memory` + `ENVIRONMENT=production` → `create_app` falha (`InMemoryAuthBlockedError`). Só sobe com `AUTH_ENABLED=false` |
| Erros | `AppError` → `{"error": {"code", "message"}}`; 401 com `WWW-Authenticate: Bearer`; 429 com `Retry-After` |

**Dependências novas (fixadas):** `argon2-cffi==25.1.0` (Argon2id mantido, sem
criptografia própria), `PyJWT==2.15.1` (JWT com validação de claims) e
`email-validator==2.3.0` (sintaxe de e-mail; já é a biblioteca usada pelo Pydantic).
Todas publicadas há mais de duas semanas da data de integração.

**Evolução do contrato planejado:**
- `POST /auth/refresh` passou a devolver também o **novo** `refreshToken` (rotação); antes
  estava planejado só `{ accessToken }`.
- `GET /auth/me` devolve `{ user }`, sem `membership` (escritórios na próxima etapa).
- Novos: `register`, `forgot-password`, `reset-password`.
- Usuário público ganhou `createdAt` (previsto no modelo de domínio).

## 4. Uso
```bash
cd backend
pip install -r requirements-dev.txt
uvicorn app.main:app --reload --port 8000
```
```bash
curl -X POST localhost:8000/api/v1/auth/register -H 'content-type: application/json' \
  -d '{"name":"Ana Souza","email":"ana@exemplo.com","password":"<sua-senha>"}'
curl -X POST localhost:8000/api/v1/auth/login -H 'content-type: application/json' \
  -d '{"email":"ana@exemplo.com","password":"<sua-senha>"}'
curl localhost:8000/api/v1/users/me -H 'Authorization: Bearer <accessToken>'
```
Para segredo estável entre reinícios em desenvolvimento, defina `AUTH_JWT_SECRET` no `.env`
(os usuários continuam se perdendo ao reiniciar, pois o armazenamento é em memória).

## 5. Testes
Arquivos: `test_auth_register_login.py`, `test_auth_tokens.py`, `test_auth_refresh.py`,
`test_auth_password_reset.py`, `test_users_me.py`, `test_auth_security.py`, com fixtures
em `tests/conftest.py` (`FakeClock`, `CapturingDelivery`, `make_app`).
Os testes usam os serviços e repositórios **reais** (Argon2id, PyJWT, locks); só o relógio
e o canal de entrega são substituídos. Concorrência: threads com `Barrier` no cadastro,
no refresh e no reset.

## 6. Limitações (importante)
- **Perda de dados ao reiniciar:** usuários, sessões e tokens existem só na memória.
- **Incompatível com múltiplos workers/processos:** cada processo tem seu próprio estado
  e, sem `AUTH_JWT_SECRET`, seu próprio segredo. Rode com **um** worker.
- **Não está pronto para produção:** bloqueado em `production` por padrão.
- **Rate limiting em memória:** por processo, zera ao reiniciar, não é distribuído. Login é
  limitado por par IP + e-mail; recuperação, por e-mail. Usa o IP visto pelo servidor
  (`X-Forwarded-For` é ignorado de propósito); atrás de proxy, todos podem compartilhar o
  IP do proxy. Produção exigirá armazenamento compartilhado (ex.: Redis) e IP confiável.
- **Refresh concorrente:** dois usos simultâneos do mesmo refresh token são tratados como
  reutilização: um vence e a família é revogada. O cliente deve serializar o refresh.
- **Cadastro revela existência de e-mail** (409), por exigência de unicidade explícita;
  login e recuperação não revelam.
- **Recuperação sem entrega real:** o adaptador padrão só registra o evento (sem e-mail e
  sem token). A entrega real depende da etapa de e-mail.
- **Diferenças de tempo** entre e-mail existente/inexistente na recuperação não são
  equalizadas (não envolvem hash de senha).
- Access tokens antigos de uma sessão ativa continuam válidos até expirar após um refresh
  (a revogação é por sessão).
- Preferências do usuário não foram implementadas.
