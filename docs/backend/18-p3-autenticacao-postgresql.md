# 18 — P3: autenticação no PostgreSQL

> **Base:** `main` `3717cf683733efaba5aeb3c6eea3934c957f3ee3` (merge do PR #19, P2). CI pós-merge
> verde, incluindo o E2E. Branch: `feature/persistence-p3-auth`.
>
> **Correções da auditoria** (commit incremental sobre `10603b7`): expiração efetiva da recuperação
> (§3.1), decisão D6 na autenticação SQL (§3.2), coordenação determinística dos testes (§5.1) e
> equivalentes SQL dos testes `memory_only` (§5.2).
>
> **Escopo:** usuários, sessões, hashes de refresh usados e tokens de recuperação no PostgreSQL
> (SQLAlchemy Core + psycopg síncrono), com o modo intermediário `STORAGE=auth-postgres`.
> O domínio continua em memória. Contratos HTTP, códigos de erro e políticas foram preservados.
> Migrations publicadas não foram alteradas, e produção continua bloqueada.

## 1. Mapa dos arquivos
```
backend/app/
├─ repositories/auth.py            # Protocols (contrato) + get_with_user (leitura consistente)
├─ repositories/memory.py          # implementação em memória (mantida) + get_with_user
├─ repositories/sql/               # P3: implementação PostgreSQL (importada só em auth-postgres)
│  ├─ _base.py                     # SqlContext: transação numa conexão, relógio pós-lock, checkpoints, ids, erros
│  ├─ users.py                     # SqlUserRepository (UNIQUE de e-mail → EmailAlreadyRegisteredError)
│  ├─ sessions.py                  # SqlSessionRepository: login, rotação, reutilização, teto, logout, expurgo
│  ├─ resets.py                    # SqlPasswordResetRepository: pedido, pré-validação, redefinição completa
│  └─ schema_check.py              # verificação SOMENTE LEITURA da revisão 0002
├─ services/auth_container.py      # composição: memória ou SQL; engine; close()
├─ services/auth_service.py        # authenticate usa get_with_user (sessão + usuário do mesmo instante)
├─ core/config.py                  # STORAGE=auth-postgres, ALLOW_VOLATILE_DOMAIN, hide_input_in_errors
├─ api/health.py, schemas/health.py# storage/durable só fora do modo memory
└─ main.py                         # lifespan encerra o engine; falha na composição também encerra
backend/tests/
├─ test_auth_contract.py           # contrato comum: memória × PostgreSQL (11 + 11 = 22)
├─ test_auth_sql_concurrency.py    # concorrência real com gates e conexões distintas (19)
├─ test_auth_storage_modes.py      # modos, esquema recusado, fluxos HTTP, reinício, logs (18)
├─ test_auth_sql_hardening.py      # auditoria: expiração entregue = persistida, D6 (409), equivalentes memory_only
├─ auth_sql_support.py             # Gates, Runner, construtores de usuário/sessão/token
└─ conftest.py                     # make_app com PRAZOAI_TEST_STORAGE=auth-postgres; marcador memory_only
```

## 2. Caminho de uma requisição (`POST /auth/refresh` em auth-postgres)
1. A rota chama `AuthService.refresh`, que gera o novo refresh e chama `sessions.rotate_refresh(hash_antigo,
   hash_novo, …)`.
2. `SqlSessionRepository` localiza a sessão pelo hash atual, **sem bloqueio**. Se não achar, procura
   o hash no histórico (caminho de reutilização).
3. Abre **uma transação numa conexão**:
   - `SELECT credential_version FROM users … FOR SHARE`;
   - `SELECT … FROM auth_sessions … FOR UPDATE`;
   - só então captura `tx_now = clock.now()`.
4. Revalida, em ordem:
   - o hash ainda é o atual (senão: reutilização → revoga);
   - a sessão não está revogada nem expirada;
   - a versão da credencial não mudou (senão revoga);
   - o teto de rotações não foi atingido (senão revoga e responde `LIMIT_REACHED`).

   Toda revogação é **confirmada** antes de o serviço responder 401.
5. Rotação: grava o hash antigo em `auth_used_refresh_hashes`, troca o hash atual, incrementa
   `rotation_count` e faz `COMMIT`.
6. O serviço devolve o novo par de tokens. Erros viram 401 com os códigos atuais
   (`invalid_refresh_token`, `session_rotation_limit_reached`).

## 3. Fronteiras transacionais e ordem dos bloqueios
Ordem única da autenticação: **`users` → `password_reset_tokens` → `auth_sessions`**. Cada linha da
tabela é uma transação numa única conexão.

| Operação | Bloqueios (em ordem) | `tx_now` | Revalidação |
|---|---|---|---|
| Cadastro | nenhum; `UNIQUE(email)` decide a corrida (só `uq_users_email` vira 409) | do serviço | — |
| Login | `users FOR NO KEY UPDATE` → sessões do usuário `FOR UPDATE` (só se o limite exigir remoção) | após `users` | versão = a verificada pelo Argon2 (fora da transação) |
| Rehash | `UPDATE … WHERE credential_version = :v` (bloqueio implícito) | — | versão no `WHERE` |
| Rotação | `users FOR SHARE` → sessão `FOR UPDATE` | após a sessão | hash atual, revogação, expiração, versão, teto |
| Reutilização | `users FOR SHARE` → sessão `FOR UPDATE` | após a sessão | não expirada → revoga (confirmada) |
| Logout | sessão `FOR UPDATE` | após a sessão | idempotente; só a família indicada |
| Pedido de recuperação | `users FOR NO KEY UPDATE` → tokens do usuário | após `users` | invalida o ativo e insere o novo |
| Redefinição | `users FOR UPDATE` → token `FOR UPDATE` → sessões (`UPDATE`) | após o token | token ativo em `tx_now` e do mesmo usuário |
| `authenticate` | nenhum: **uma** consulta com junção sessão + usuário | do serviço | revogação, expiração, versão |
| Expurgo de sessões | lotes `FOR UPDATE SKIP LOCKED` | por lote | `expires_at <= tx_now` |

Regras gerais:
- **Argon2 fora de locks e transações:** verificação e hash no serviço, antes; o rehash vem depois
  do `COMMIT` do login.
- **Entrega da recuperação depois do `COMMIT`:** continua `Noop` (sem e-mail).
- **Sem repetição automática:** em deadlock ou `lock_timeout`, nenhuma mutação é repetida; o erro
  propaga (o `ROLLBACK` é automático e a conexão volta ao pool).
- **Instantes gravados:** `created_at` e `expires_at` da sessão e do token usam `tx_now`, com o TTL
  definido pelo serviço.

**Retenção e limpeza mínima (sem a manutenção geral da P5):**
- **Histórico de hashes:** preservado enquanto a família existir, inclusive revogada; some só
  quando a sessão é apagada.
- **Limite de sessões no login:** remove expiradas, depois revogadas, depois as mais antigas, com
  o histórico (política atual).
- **Pedido de recuperação:** apaga os tokens mortos (usados, invalidados ou expirados) só do
  próprio usuário.
- **`purge_expired`:** existe e foi testado, mas não roda periodicamente. Sessões expiradas de
  quem não volta a entrar ficam até a P5. Diferença registrada: a memória expurgava globalmente a
  cada intervalo.

### 3.1 Expiração efetiva da recuperação de senha
- `issue_replacing_active` agora **devolve o registro persistido**. No PostgreSQL, `created_at` e
  `expires_at` vêm do relógio capturado depois do bloqueio do usuário; na memória, o registro
  recebido.
- O serviço envia na mensagem `issued.expires_at`, não a expiração calculada antes da transação.
- A entrega acontece **só depois do `COMMIT`**: se a transação falhar, nada é entregue.
- O token não aparece em logs.

### 3.2 Decisão D6: conflito de concorrência
- `SqlContext.transaction`/`read` traduzem **somente** os SQLSTATEs `40P01` (deadlock) e `55P03`
  (bloqueio indisponível ou `lock_timeout`) para `ConcurrentUpdateError`.
- A tradução acontece **depois** do `ROLLBACK` e da devolução da conexão ao pool.
- O handler HTTP responde `409 {"error":{"code":"concurrent_update","message":"Outra operação
  simultânea impediu esta. Tente novamente."}}`, sem detalhes internos.
- **Não há repetição automática.**
- Qualquer outro erro do banco (por exemplo, `57014`, consulta cancelada por `statement_timeout`)
  continua inesperado: propaga e vira 500.

## 4. Modo intermediário `STORAGE=auth-postgres`
| Condição | Resultado |
|---|---|
| `ENVIRONMENT=test` | aceito |
| `ENVIRONMENT=development` + `ALLOW_VOLATILE_DOMAIN=true` | aceito |
| `development` sem a opção, `staging`, `production` | recusado na validação |
| `AUTH_STORAGE` definido junto | recusado (conflito; `AUTH_STORAGE=memory` sozinho continua aceito com aviso) |
| `STORAGE=postgres` | recusado (P4) |
| `DATABASE_URL` ausente ou inválida | recusa no startup (mensagem sem credenciais) |
| Esquema ausente ou em revisão ≠ `0002` | recusa no startup, **sem criar nem migrar nada** (verificação somente leitura) |

Quando aceito:
- o startup registra `storage_auth_postgres_volatile_domain`;
- `GET /api/v1/health` responde `{"status","service","storage":"auth-postgres","durable":false}`
  (em `memory` a resposta continua só com `status` e `service`);
- o domínio em memória recebe o **mesmo** `SqlUserRepository` (sem segunda cópia de contas);
- o engine é encerrado no `lifespan` e também se a composição falhar.

**Correção de segurança encontrada:** os erros de validação das configurações passaram a usar
`hide_input_in_errors=True`. Antes, um validador de modelo podia exibir o final da `DATABASE_URL`
na mensagem (exposição parcial de senha). Há um teste de regressão.

## 5. Testes
| Suíte | O que prova |
|---|---|
| `test_auth_contract.py` | mesmo contrato em memória e PostgreSQL: usuários, e-mail único, rehash condicional, sessão condicionada à credencial, política de limite, rotação, reutilização, teto, expiração exata, logout, token único, redefinição atômica |
| `test_auth_sql_concurrency.py` | **PostgreSQL real, threads e gates**: cadastro simultâneo; login × reset e reset × login; rehash × reset; refresh × reset nas duas ordens; dois refreshes; dois resets; pedidos simultâneos; limite concorrente; teto e reutilização; expiração durante a espera (relógio pós-lock) e no instante exato; token expirando durante a espera; falhas injetadas antes do `COMMIT` sem efeitos parciais; conexões devolvidas ao pool |
| `test_auth_storage_modes.py` | modos aceitos e recusados; erros sem valores; `DATABASE_URL` ausente; produção bloqueada; `memory` sem importar SQLAlchemy; esquema `0001` ou `base` recusado sem escrita; fluxos HTTP completos; domínio com o mesmo repositório de usuários; revogação por teto persistida apesar do 401; reinício da app **e do engine** com segredo JWT estável; logs sem segredos |
| CI `PRAZOAI_TEST_STORAGE=auth-postgres` | as suítes HTTP de autenticação já existentes (cadastro, login, refresh, recuperação, tokens, perfil, proteção de custo) contra PostgreSQL real; testes que inspecionam a memória (`memory_only`) são pulados nesse modo |

### 5.1 Coordenação determinística
- Nos testes de concorrência, o teste só avança o relógio ou libera um bloqueio **depois de ver no
  PostgreSQL** que a operação está esperando o bloqueio pretendido
  (`tests/auth_sql_support.wait_for_lock_waiter`). A observação usa `pg_stat_activity` com
  `wait_event_type = 'Lock'` e, quando o detentor é conhecido, `pg_blocking_pids(pid)` contendo o
  PID dele.
- `thread.is_alive()` depois de um timeout não é mais usado para ordenar. Timeouts restam só como
  proteção contra travamento.
- **Conexões de controle** (as que seguram bloqueios) são abertas por `control_connection`, que
  faz `ROLLBACK` e fecha a conexão em `finally`, mesmo quando uma asserção falha.
- **Deadlock real** (`test_deadlock_real_qualquer_vitima_estado_final_coerente`):
  - a conexão de controle segura a sessão;
  - a app pega `users FOR SHARE` e espera a sessão (espera vista no banco);
  - o controle pede `users FOR UPDATE` e fecha o ciclo.

  **O PostgreSQL escolhe a vítima, e essa escolha não é contratual**, então o teste aceita qualquer
  uma, sem repetir o cenário:
  - *vítima = app:* 409 `concurrent_update`, nenhuma alteração e o token original continua válido;
  - *vítima = controle:* `40P01` na conexão de controle e a app conclui a rotação (200), com estado
    completo, não parcial.

  Em ambos os casos: uma única chamada ao repositório e conexões devolvidas.
- **Tradução HTTP determinística** (`test_traducao_http_de_40p01_por_injecao_controlada`), por
  **injeção controlada**, identificada no teste:
  - um `psycopg.errors.DeadlockDetected` (`40P01`), embrulhado como `OperationalError`, é lançado
    dentro da transação (ponto `rotate:locked`, depois dos bloqueios e antes de qualquer escrita);
  - prova o caminho `SqlContext` → 409, o `ROLLBACK`, a devolução da conexão, a ausência de
    repetição e que o token original continua válido;
  - não substitui o teste de deadlock real.

### 5.2 Equivalentes SQL dos testes `memory_only`
Os quatro testes originais continuam rodando em memória. Cobertura equivalente no PostgreSQL, por
fluxos HTTP reais e inspeção dos valores persistidos (`tests/test_auth_sql_hardening.py`):

| Teste em memória | Equivalente PostgreSQL | O que é inspecionado |
|---|---|---|
| `test_senha_armazenada_somente_como_hash_argon2id` | `test_sql_senha_armazenada_somente_como_argon2id` | `users.password_hash` começa com `$argon2id$`; a senha não aparece em nenhuma coluna das tabelas de autenticação |
| `test_refresh_token_armazenado_somente_como_hash` | `test_sql_refresh_token_armazenado_somente_como_hash` | `current_refresh_hash` = SHA-256 do token atual; o token girado só como hash em `auth_used_refresh_hashes`; nenhum token em claro |
| `test_token_aleatorio_armazenado_somente_como_hash` | `test_sql_token_de_recuperacao_armazenado_somente_como_hash` | `password_reset_tokens.token_hash` = hashes dos dois tokens entregues; nenhum token em claro |
| `test_reset_invalida_outros_tokens_e_revoga_todas_as_sessoes` | `test_sql_reset_revoga_todas_as_sessoes_e_invalida_os_tokens_aplicaveis` | as duas sessões revogadas (`/auth/me` e refresh → 401; nenhuma linha com `revoked_at` nulo); token usado com `used_at`; token anterior com `invalidated_at` e recusado |

**Adaptação:** o quarto teste em memória injetava um segundo token **pendente**, o que a constraint
de um token ativo por usuário impede, corretamente. A constraint não foi afrouxada. O equivalente
usa o token anterior, invalidado pela nova emissão, e confirma que ele continua inválido depois da
redefinição.

## 6. Comandos seguros
```bash
cd backend
# banco DESCARTÁVEL de desenvolvimento, já migrado
export DATABASE_URL=postgresql+psycopg://prazoai:<senha>@localhost:5432/prazoai_dev
alembic upgrade head                                     # 0002 (explícito; nunca no startup)
ENVIRONMENT=development STORAGE=auth-postgres ALLOW_VOLATILE_DOMAIN=true \
  AUTH_JWT_SECRET=<segredo-estável> uvicorn app.main:app --no-proxy-headers

# testes (banco de TESTE separado, prazoai_test*, local)
ENVIRONMENT=test TEST_DATABASE_URL=postgresql+psycopg://prazoai:<senha>@localhost:5432/prazoai_test pytest
ENVIRONMENT=test TEST_DATABASE_URL=... PRAZOAI_TEST_STORAGE=auth-postgres pytest tests/test_auth_refresh.py
```

## 7. Decisões e limitações
- **Relógio pós-lock no SQL:** os métodos recebem `now` do serviço por compatibilidade com o
  contrato, mas o SQL usa o relógio injetável capturado depois dos bloqueios (doc 15, §4.6). A
  memória continua usando o `now` recebido (esperas de microssegundos).
- **`get_with_user`** entrou no contrato para o `authenticate` ler sessão e usuário do mesmo instante.
- **D6 já aplicada na autenticação SQL:** deadlock e `lock_timeout` → `409 concurrent_update`, sem
  repetição automática (§3.2).
- **Domínio volátil:** em `auth-postgres`, escritórios, prazos, intimações e notificações se perdem
  ao reiniciar (por isso o modo só é aceito em teste e desenvolvimento explícito).
- **Expurgo global de sessões e tokens:** P5.
- **Rate limiting:** continua por processo.
- **Teste E2E intermitente corrigido** (`frontend/e2e/deadlines.spec.ts`, cenário do calendário com
  505 prazos, da auditoria da 6.3). O *listener* permanente de respostas continuava lendo corpos
  de carregamentos posteriores e falhava ao fechar o contexto. Agora usa `waitForResponse` para a
  página 2 do primeiro carregamento. Cobertura idêntica, sem retry; o código do produto não mudou.

## 8. Roteiro de apresentação (Lucas, cerca de 5 minutos)
1. **Contexto (30 s):** "Na P3, contas e sessões passam a sobreviver a reinícios. O resto do sistema
   ainda é memória, por isso existe um modo intermediário só para teste e desenvolvimento."
2. **Arquitetura (1 min):** o serviço não mudou de regras; dois conjuntos de repositórios cumprem o
   mesmo contrato, e os mesmos testes rodam nos dois.
3. **Refresh passo a passo (1 min 15 s):** bloquear usuário e sessão, olhar o relógio só depois,
   revalidar e girar. Se o token já foi usado, a família é revogada e isso fica gravado mesmo com
   a resposta 401.
4. **Redefinição de senha (45 s):** uma transação faz tudo: consome o token, troca a senha, sobe a
   versão da credencial, invalida os outros tokens e derruba as sessões.
5. **Prova de concorrência (1 min):** threads reais com conexões distintas e pontos de pausa, como
   dois refreshes do mesmo token (um gira, o outro detecta reutilização) e login × reset nas duas
   ordens. E o reinício: derrubar a app e o engine, subir de novo, e o token continua valendo.
6. **Limites (30 s):** domínio ainda em memória (P4), expurgo global (P5) e produção bloqueada.
