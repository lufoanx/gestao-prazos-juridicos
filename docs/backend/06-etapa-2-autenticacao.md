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
| Versão da credencial | `User.credential_version` sobe atomicamente na redefinição. Sessão guarda a versão do login; criação de sessão, rehash, refresh e autenticação conferem a versão |
| Custo (Argon2) | Limites checados antes de qualquer hash; cadastro com e-mail já existente e redefinição com token inativo não calculam hash; nenhum lock é mantido durante o Argon2 |
| Histórico de rotações | Teto configurável por sessão (`AUTH_MAX_REFRESH_ROTATIONS_PER_SESSION`, padrão 1000); ao atingir, o próximo refresh encerra a sessão. Hashes antigos nunca são descartados enquanto a família existe |
| Retenção | Limitadores com varredura de chaves expiradas e teto de chaves (transbordo compartilhado); sessões expiradas e tokens de recuperação inativos removidos periodicamente; máximo de sessões por usuário |

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

## 3.1 Correções da auditoria independente
1. **Login × redefinição.** Causa: o login lia hash e usuário, verificava a senha e criava
   a sessão sem confirmar que a credencial ainda era a mesma; uma redefinição concluída
   nesse intervalo deixava passar uma sessão baseada na senha antiga (reproduzido com
   pausa determinística). O rehash gravava incondicionalmente e podia restaurar a senha
   antiga. Solução: `credential_version` + operações condicionais atômicas
   (`add_if_credentials_current`, `update_password_hash_if_version`); a redefinição
   incrementa a versão na mesma operação que troca o hash e revoga as sessões;
   `authenticate`/`refresh` rejeitam versões divergentes.
2. **Recuperação/redefinição não atômicas.** Causa: `forgot_password` invalidava e depois
   inseria em chamadas separadas; a redefinição consumia, trocava hash, invalidava e
   revogava em passos separados. Solução: `issue_replacing_active` (invalida + insere no
   mesmo lock: no máximo um token ativo) e `complete_reset` (revalida, consome, troca o
   hash e a versão, invalida os demais tokens e revoga todas as sessões numa única
   operação). Em banco, cada uma deve ser uma transação.
3. **Operações públicas caras.** Causa: `reset_password` calculava Argon2 antes de olhar o
   token; cadastro e redefinição não tinham limite. Solução: limites por IP para cadastro
   e redefinição verificados antes de tudo; pré-validação barata do token (`is_active`,
   sem consumir) antes do hash, com revalidação atômica em `complete_reset`; cadastro com
   e-mail já existente responde 409 sem hash (unicidade continua atômica em `add`).
4. **Crescimento do estado temporário.** Causa: o limitador nunca removia chaves; sessões
   e tokens expirados ficavam para sempre. Solução: varredura periódica (uma vez por
   janela, pelo relógio injetado) e sob demanda; teto de chaves com balde de transbordo;
   limpeza periódica (a cada 60 s de relógio, em escritas) de sessões expiradas e tokens
   inativos; limite de sessões por usuário. Sessões revogadas ficam até a expiração
   absoluta, preservando a detecção de reuso de refresh tokens durante a validade.

5. **Histórico de rotações sem limite (auditoria v2).** Causa: cada refresh acrescentava
   um hash ao histórico da sessão e ao índice global, sem teto; 500 refreshes deixavam 500
   hashes até a expiração, e `get`/`rotate_refresh` copiavam o conjunto inteiro.
   Solução: teto configurável de rotações por sessão. Ao apresentar o token atual de uma
   sessão que já girou o teto, a sessão é **encerrada** (revogada) dentro do mesmo lock da
   rotação e o cliente recebe 401 `session_rotation_limit_reached`. O repositório agora
   devolve `SessionView` (sem hashes), sem copiar o histórico.
   **Por que encerrar a sessão** (e não descartar hashes antigos ou "compactar"): descartar
   hashes de uma família ainda viva faria um token antigo roubado parecer apenas
   "desconhecido" (INVALID), sem revogar a família — enfraquece a detecção de reuso. Encerrar
   mantém a detecção intacta, limita a memória a `teto + 1` hashes por sessão (≈
   `AUTH_MAX_SESSIONS_PER_USER × (teto + 1)` por usuário) e custa só um novo login. O padrão
   1000 fica acima das ~672 rotações de uma sessão de 7 dias renovada a cada 15 min; na
   prática, a vida absoluta da sessão costuma terminar antes do teto.

### Orientações para a futura integração do frontend
- Fazer refresh **um de cada vez** por sessão (fila/mutex no cliente); duas chamadas
  simultâneas com o mesmo refresh token são tratadas como reutilização e encerram a sessão.
- Sempre substituir o refresh token guardado pelo novo devolvido em cada refresh.
- Tratar **qualquer 401 no refresh** como fim da sessão: limpar o estado e mandar para o
  login. Os códigos distinguem a causa para mensagens/telemetria:
  `invalid_refresh_token` (expirado, revogado, reutilizado, credencial alterada) e
  `session_rotation_limit_reached` (limite de renovações; mensagem amigável "faça login
  novamente").
- Não guardar senhas; o armazenamento dos tokens no navegador será definido na etapa de
  integração (o frontend atual continua demonstrativo).

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
`test_auth_password_reset.py`, `test_users_me.py`, `test_auth_security.py`,
`test_auth_consistency.py` (login/rehash × reset, recuperação e redefinições concorrentes),
`test_auth_cost_protection.py` (contagem de chamadas ao hasher) e `test_auth_retention.py`
(limpeza e tetos), com fixtures em `tests/conftest.py` (`FakeClock`, `CapturingDelivery`,
`InstrumentedHasher` — Argon2id real com contadores e pausas por Event —, `make_app`).
Os testes usam os serviços e repositórios **reais** (Argon2id, PyJWT, locks); só o relógio
e o canal de entrega são substituídos. Concorrência: threads com `Barrier` no cadastro,
no refresh e no reset.

## 6. Limitações (importante)
- **Perda de dados ao reiniciar:** usuários, sessões e tokens existem só na memória.
- **Incompatível com múltiplos workers/processos:** cada processo tem seu próprio estado
  e, sem `AUTH_JWT_SECRET`, seu próprio segredo. Rode com **um** worker.
- **Não está pronto para produção:** bloqueado em `production` por padrão.
- **Rate limiting em memória:** por processo, zera ao reiniciar, não é distribuído. Login é
  limitado por par IP + e-mail; recuperação, por e-mail; cadastro e redefinição, por IP.
  Sob inundação de chaves distintas acima de `AUTH_RATE_LIMIT_MAX_KEYS`, chaves novas
  compartilham um balde e podem ser limitadas juntas (degradação segura escolhida para
  não permitir zerar contadores existentes). Usa o IP visto pelo servidor
  (`X-Forwarded-For` é ignorado de propósito); atrás de proxy, todos podem compartilhar o
  IP do proxy. Produção exigirá armazenamento compartilhado (ex.: Redis) e IP confiável.
- **Refresh concorrente:** dois usos simultâneos do mesmo refresh token são tratados como
  reutilização: um vence e a família é revogada. O cliente deve serializar o refresh.
- **Cadastro revela existência de e-mail** (409), por exigência de unicidade explícita;
  login e recuperação não revelam. O 409 sem hash é mais rápido que um cadastro novo.
- **Limite de sessões:** ao exceder `AUTH_MAX_SESSIONS_PER_USER`, as sessões mais antigas
  (expiradas, depois revogadas, depois as mais antigas) são removidas sem aviso.
- **Usuários não expiram:** o crescimento de contas é contido só pelo limite de cadastro.
- **Recuperação sem entrega real:** o adaptador padrão só registra o evento (sem e-mail e
  sem token). A entrega real depende da etapa de e-mail.
- **Diferenças de tempo** entre e-mail existente/inexistente na recuperação não são
  equalizadas (não envolvem hash de senha).
- Access tokens antigos de uma sessão ativa continuam válidos até expirar após um refresh
  (a revogação é por sessão).
- Preferências do usuário não foram implementadas.
