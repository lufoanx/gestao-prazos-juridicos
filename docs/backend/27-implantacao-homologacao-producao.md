# 27 — Implantação: homologação, produção e rollback

> **Atualização (doc 28):** a hospedagem pretendida passou a ser o **Azure**; os PDFs das intimações
> ficam no Azure Blob Storage privado (requisito hospedado `FILE_STORAGE=azure_blob`) e o esquema exigido
> passou a `0004`. Os números de testes das §13 referem-se à entrega anterior; os desta estão no doc 28.

> **Situação desta entrega:** **implementado e testado localmente** (recursos descartáveis, dados
> fictícios). **Nada foi implantado.** O sistema **não está validado para uso real**: os itens da §14
> só podem ser cumpridos no ambiente hospedado, com provedor de e-mail, domínio e banco definidos
> pelo responsável do projeto. Os critérios objetivos para liberar contas reais estão na §15.

Base: `main` em `1d6d7fc` (igual a `origin/main` no início do trabalho). Branch: `feature/implantacao-homologacao`.
O SHA final desta entrega é o último commit da branch (§17).

---

## 1. Diagnóstico (antes desta entrega)

| Item | Estado encontrado no código | Classificação |
|---|---|---|
| Cadastro, login, escritórios, equipe, permissões, prazos, calendário, intimações | integrados (BFF + FastAPI), PostgreSQL via `STORAGE=postgres` | já implementado |
| Recuperação de senha (SMTP em subprocesso, fila limitada, telas) | integrada e testada contra Mailpit | já implementado |
| `ENVIRONMENT=production` | recusado **incondicionalmente** (`ProductionNotReleasedError`); `STORAGE=postgres` só em development/test; `staging` aceitava memória com só `AUTH_JWT_SECRET` | correção necessária |
| Defesas adicionais | `auth_container` recusava produção mesmo com PostgreSQL (`auth_storage` é sempre `"memory"`); `org_container` recusava escritórios em produção | correção necessária |
| Migrations e `app.db check` | bloqueados em produção | correção necessária |
| Sessões do BFF | `Map` em memória no processo Node; síncronas; corretas só com um processo | correção necessária |
| IP do cliente | backend só aceita `X-PrazoAI-Client-IP` com `TRUSTED_PROXY_SECRET`; BFF só encaminha cabeçalho sobrescrito pela infraestrutura; ambos **opcionais** | correção necessária (obrigatório em hospedado) |
| Limitadores de taxa e fila de e-mail | em memória, por processo | limitação documentada (§9) |
| Provedor de e-mail, domínio, remetente (SPF/DKIM/DMARC), banco gerenciado, HTTPS, segredos | inexistentes | configuração externa |
| Entrega real de e-mail, IP real atrás da borda, backup gerenciado, monitoramento | — | só validáveis no ambiente hospedado |

## 2. O que esta entrega mudou

**Backend**
- `HostedConfigError` + `ensure_hosted_requirements()` (`app/core/config.py`) substituem o bloqueio
  incondicional: `staging` e `production` só iniciam com **todos** os requisitos (§5). A mensagem
  lista todos os problemas de uma vez e nunca contém valores.
- `STORAGE=postgres` aceito em staging/production; memória recusada (também nas defesas adicionais).
- Documentação interativa e OpenAPI (`/docs`, `/redoc`, `/openapi.json`) desligadas em staging **e** production.
- `GET /api/v1/health/ready`: banco e revisão do esquema (somente leitura, prazo de 2 s; 503 sem detalhes).
- Migrations em staging/production: exigem `sslmode` e `PRAZOAI_CONFIRM_MIGRATION_TARGET=<host>:<porta>/<banco>`.
  `python -m app.db check` (somente leitura) liberado. Manutenção (`python -m app.maintenance purge`)
  exige a configuração hospedada completa.
- `backend/Dockerfile`: um worker, `--no-proxy-headers`, usuário sem privilégios, sem segredos na imagem.

**BFF (Next.js, só servidor)**
- Armazenamento **compartilhado** de sessões no PostgreSQL (`session-store-pg.mjs`), esquema próprio
  `prazoai_bff`, com o mesmo contrato do armazenamento em memória (que continua para demo local/testes).
- Todas as seções críticas viraram **operações atômicas do armazenamento** (§7); a renovação usa
  **lease por geração** entre instâncias.
- Em repouso: só `SHA-256` do id de sessão e do id do navegador; tokens cifrados com AES-256-GCM,
  amarrados à linha e ao campo; rotação de chave com chave anterior só para decifrar.
- `PRAZOAI_APP_ENV=staging|production` exige: origem HTTPS não-loopback, `PRAZOAI_PROXY_SECRET` +
  `PRAZOAI_TRUSTED_CLIENT_IP_HEADER`, sessões no PostgreSQL com `sslmode`, chave de sessão e backend
  em HTTPS (ou rede privada declarada com `PRAZOAI_BACKEND_PRIVATE_NETWORK=true`).
- `GET /bff/health`; `npm run bff:sessions -- check|migrate`; armazenamento indisponível → 503
  `session_store_unavailable` (logout responde 503 sem fingir sucesso e apaga só os cookies observados).
- Login cujo armazenamento falhe depois do backend emitir tokens **revoga** o par emitido.

**CI** — PostgreSQL no job do frontend (contrato + várias instâncias), sessões no PostgreSQL na
integração e no E2E, PostgreSQL com TLS para os testes de ambiente hospedado, papéis com privilégios
mínimos e o job `docker` (build e execução das imagens, sem publicar). Resultados no PR #35.

## 3. Arquitetura e topologia proposta

```
Navegador ──HTTPS──► Borda/plataforma (TLS, sobrescreve o cabeçalho de IP do cliente)
                          │
                          ▼
              BFF Next.js (N ≥ 1 instâncias, sem estado local)
                │   cookie opaco __Host-prazoai_sid_*  (tokens nunca saem do servidor)
                │                        │
                │ HTTPS ou rede privada  │ TLS, papel prazoai_bff_app (só esquema prazoai_bff)
                ▼                        ▼
      FastAPI (EXATAMENTE 1 instância,   PostgreSQL gerenciado
      1 worker; X-PrazoAI-Proxy-Secret)   ├─ esquema prazoai      (domínio + autenticação; papel do backend)
                │ TLS, papel do backend   └─ esquema prazoai_bff  (sessões do BFF; papel do BFF)
                └──────────────────────────►
                │ SMTP STARTTLS/TLS + AUTH
                ▼
      Provedor de e-mail transacional
```

- **Demo pública**: build separado com `NEXT_PUBLIC_PRAZOAI_MODE` vazio (ou `demo`); sem BFF, sem
  backend, sem segredos. Pode continuar onde está hoje (ex.: Vercel). **Não** reutilize o mesmo
  projeto/URL para o modo integrado.
- **BFF**: escalável horizontalmente (sessões compartilhadas). Precisa de runtime Node de longa
  duração ou funções Node (não Edge) com acesso ao PostgreSQL; o pool é pequeno (`PRAZOAI_BFF_DATABASE_POOL_MAX`).
- **Backend**: **uma** réplica com **um** worker (§9.1). Preferencialmente sem rota pública (rede
  privada da plataforma); se exposto, só HTTPS e sem CORS para o navegador (o navegador fala só com o BFF).
- **Banco**: um servidor PostgreSQL 16 gerenciado com TLS; um banco por ambiente (homologação ≠ produção).

## 4. Ambientes

| | Demo pública | Homologação | Produção |
|---|---|---|---|
| Frontend | `NEXT_PUBLIC_PRAZOAI_MODE=` (demo) | `integrated`, `PRAZOAI_APP_ENV=staging` | `integrated`, `PRAZOAI_APP_ENV=production` |
| Backend | — | `ENVIRONMENT=staging` | `ENVIRONMENT=production` |
| Banco | — | banco **próprio** (ex.: `prazoai_homolog`) | banco **próprio** (ex.: `prazoai_prod`) |
| E-mail | — | mesmo provedor, remetente/domínio de teste; destinatários fictícios ou da equipe | remetente verificado do domínio final |
| Segredos | nenhum | **próprios** (nunca reutilizar os de produção) | próprios |
| Dados | locais no navegador | **fictícios** | contas reais só após §15 |

`development` e `test` **nunca** hospedam contas reais: aceitam memória, segredo JWT efêmero e SMTP sem TLS em loopback.

## 5. Variáveis de ambiente (nomes; sem valores reais)

### 5.1 Backend (staging/production) — obrigatórias; a ausência impede o startup
| Variável | Regra |
|---|---|
| `ENVIRONMENT` | `staging` ou `production` |
| `STORAGE` | `postgres` |
| `DATABASE_URL` | `postgresql+psycopg://<papel_backend>:<senha>@<host>:<porta>/<banco>?sslmode=verify-full` (ou `require`/`verify-ca`) |
| `AUTH_JWT_SECRET` | ≥ 32 bytes aleatórios (`python -c "import secrets; print(secrets.token_urlsafe(64))"`) |
| `TRUSTED_PROXY_SECRET` | ≥ 32 bytes; **igual** a `PRAZOAI_PROXY_SECRET` do BFF |
| `PUBLIC_APP_ORIGIN` | origem HTTPS pública do BFF (ex.: `https://app.<domínio>`); base dos links de e-mail |
| `CORS_ORIGINS` | vazio (recomendado) ou exatamente `PUBLIC_APP_ORIGIN` |
| `EMAIL_TRANSPORT` | `smtp` |
| `EMAIL_FROM` | remetente verificado no provedor (`Nome <endereco@dominio>`) |
| `SMTP_HOST`, `SMTP_PORT` | do provedor (não loopback) |
| `SMTP_SECURITY` | `starttls` (porta 587) ou `tls` (porta 465) |
| `SMTP_USERNAME`, `SMTP_PASSWORD` | credencial **do projeto** no provedor (nunca pessoal) |
| `LOG_LEVEL` | `INFO` ou `WARNING` (DEBUG recusado) |
| `WEB_CONCURRENCY` | ausente ou `1` |
| `FILE_STORAGE` | `azure_blob` (PDF das intimações; doc 28) |
| `AZURE_STORAGE_CONNECTION_STRING` | segredo; `DefaultEndpointsProtocol=https`, conta real (emulador recusado) |
| `AZURE_STORAGE_CONTAINER` | container **privado** já criado (`python -m app.files check` = 0) |

Opcionais relevantes: `SMTP_CA_FILE`, `SMTP_TIMEOUT_SECONDS`, `SMTP_SEND_DEADLINE_SECONDS`,
`AUTH_*` (limites e validades), `DATABASE_POOL_SIZE` (padrão 5), `MAINTENANCE_*`, `RECOVERY_*`
(ver `backend/.env.example`). Só para migrations: `PRAZOAI_CONFIRM_MIGRATION_TARGET`.

### 5.2 BFF/frontend
| Variável | Momento | Regra |
|---|---|---|
| `NEXT_PUBLIC_PRAZOAI_MODE` | **build** | `integrated` (único valor público; nunca coloque segredos em `NEXT_PUBLIC_*`) |
| `PRAZOAI_APP_ENV` | execução | `staging` ou `production` |
| `PRAZOAI_APP_ORIGIN` | execução | mesma origem HTTPS de `PUBLIC_APP_ORIGIN` |
| `PRAZOAI_BACKEND_URL` | execução | HTTPS do backend, ou URL interna + `PRAZOAI_BACKEND_PRIVATE_NETWORK=true` |
| `PRAZOAI_PROXY_SECRET` | execução | = `TRUSTED_PROXY_SECRET` |
| `PRAZOAI_TRUSTED_CLIENT_IP_HEADER` | execução | cabeçalho que a **borda sobrescreve** com o IP do cliente (nunca `X-Forwarded-For`/`Forwarded`) |
| `PRAZOAI_BFF_SESSION_STORE` | execução | `postgres` |
| `PRAZOAI_BFF_DATABASE_URL` | execução | `postgresql://prazoai_bff_app:<senha>@<host>:<porta>/<banco>?sslmode=verify-full` |
| `PRAZOAI_BFF_SESSION_KEY` | execução | 32 bytes aleatórios em base64url (`node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`) |
| `PRAZOAI_BFF_SESSION_KEY_PREVIOUS` | execução | só durante rotação (§12.4) |

Opcionais: `PRAZOAI_BFF_DATABASE_POOL_MAX`, `PRAZOAI_BFF_MAX_SESSIONS`, `PRAZOAI_BFF_SESSION_IDLE_SECONDS`,
`PRAZOAI_BFF_SESSION_MAX_AGE_SECONDS`, `PRAZOAI_BFF_TIMEOUT_MS`. Migração do esquema:
`PRAZOAI_BFF_MIGRATION_DATABASE_URL` (papel dono) e `PRAZOAI_BFF_CONFIRM_TARGET`.

> Com `sslmode=require`, o driver Node (`pg` 8.23) **verifica o certificado** como `verify-full`.
> Se a CA do provedor não estiver no repositório do sistema, inclua `sslrootcert=<arquivo>` na URL.

## 6. Preparação do banco e das sessões

1. Crie o banco do ambiente e três papéis (nomes sugeridos), com senhas geradas e guardadas no
   gerenciador de segredos da plataforma:
   ```sql
   -- como administrador do servidor (uma vez por ambiente)
   CREATE ROLE prazoai_owner LOGIN PASSWORD '<gerada>';        -- dono dos esquemas; só migrations
   CREATE ROLE prazoai_api   LOGIN PASSWORD '<gerada>';        -- backend
   CREATE ROLE prazoai_bff_app LOGIN PASSWORD '<gerada>';      -- BFF
   CREATE DATABASE prazoai_homolog OWNER prazoai_owner;
   ```
2. Migrations do backend (cria o esquema `prazoai`) — com o papel dono, **antes** do primeiro deploy:
   ```bash
   cd backend
   ENVIRONMENT=staging DATABASE_URL='postgresql+psycopg://prazoai_owner:<senha>@<host>:5432/prazoai_homolog?sslmode=verify-full' \
   PRAZOAI_CONFIRM_MIGRATION_TARGET='<host>:5432/prazoai_homolog' alembic upgrade head
   ENVIRONMENT=staging DATABASE_URL=... python -m app.db check      # deve mostrar "revisão do esquema: 0004"
   ```
3. Esquema das sessões do BFF — com o papel dono:
   ```bash
   cd frontend
   PRAZOAI_BFF_DATABASE_URL='postgresql://prazoai_owner:<senha>@<host>:5432/prazoai_homolog?sslmode=verify-full' \
   PRAZOAI_BFF_CONFIRM_TARGET='<host>:5432/prazoai_homolog' npm run bff:sessions -- migrate
   npm run bff:sessions -- check                                      # "versão do esquema prazoai_bff: 1"
   ```
4. Privilégios mínimos (o BFF **não** acessa o domínio; o backend **não** acessa as sessões do BFF):
   execute **`backend/deploy/privilegios-minimos.sql`** com o papel dono, depois de trocar os marcadores
   `__OWNER__`, `__API__`, `__BFF__` e `__DB__` pelos nomes reais (ex.: `sed` numa cópia local; o
   arquivo não contém segredos). Ele também define `ALTER DEFAULT PRIVILEGES`, então tabelas novas do
   esquema `prazoai` criadas por migrations do dono já recebem os privilégios da API. Reexecute-o
   depois de qualquer migration do esquema `prazoai_bff`.
   **Testado** com esse mesmo arquivo em `frontend/tests/integration/least-privilege-backend.test.mjs`
   (§13.1): a API não lê `prazoai_bff`; o BFF não lê `prazoai.*`; nenhum papel de execução cria, altera
   ou apaga tabelas/esquemas; `alembic downgrade` com o papel da API é recusado sem alterar a revisão;
   `app.db check` e a manutenção funcionam com o papel da API; cadastro, login, perfil, escritório,
   convite, prazos, comentário, calendário, intimação, notificações, renovação e logout funcionam com
   os papéis de execução.
5. Opcional: banco **separado** para as sessões do BFF (mesmo servidor ou outro). O código só exige
   que `PRAZOAI_BFF_DATABASE_URL` aponte para um banco com o esquema `prazoai_bff`.

## 7. Sessões compartilhadas do BFF — escolha e garantias

**Escolha: PostgreSQL (esquema e papel próprios).** O doc 15 recomendava Redis; a escolha foi revista
porque (a) o PostgreSQL já é obrigatório e gerenciado no mesmo provedor, sem serviço nem custo extra;
(b) as operações críticas precisam de **transações com bloqueio**, não só de TTL; (c) sessões
sobrevivem a reinícios do armazenamento sem configurar persistência; (d) a carga é pequena (uma
escrita por requisição autenticada). As objeções do doc 15 foram atendidas: o BFF **não** lê o
esquema do domínio (papel próprio, §6.4) e os tokens ficam **cifrados em repouso**.

| Requisito | Como é garantido | Evidência |
|---|---|---|
| Cookies HttpOnly, Secure, SameSite=Strict, `__Host-` | inalterado (`security.mjs`); hospedado exige HTTPS | `bff-core.test.mjs`; ensaio §13.2 passo 2 |
| Inatividade e idade máxima | predicado em toda leitura (`last_seen_at`, `created_at`); varredura periódica | contrato `[postgres] expiração…` |
| Revogação e logout | `endSessions` atômico (cookies observados + todo o navegador) e revogação no backend | `[postgres] instâncias distintas…`; integração real |
| Rotação de tokens | troca condicional por geração (`UPDATE … WHERE generation = $g`) | contrato `[postgres] troca condicional…` |
| Renovação concorrente | **lease por geração** (`UPDATE … WHERE generation = $g AND refresh_owner IS NULL`); outras instâncias aguardam a troca de geração | `[postgres] renovação concorrente…` (1 refresh), integração real sem detecção de reutilização |
| Renovação com resultado incerto | o lease **só é liberado** quando a falha é comprovadamente anterior ao envio (conexão recusada) ou o backend respondeu sem girar o par (5xx/429). **Lease vencido com tentativa em aberto não libera nada**: o backend pode ter consumido o refresh (instância caiu, travou ou falhou ao persistir). A próxima instância que acessar a sessão a **encerra** (`abandonRefresh`, atômico), tenta revogar o access token antigo e responde 401 `session_refresh_uncertain` (novo login) — **o refresh antigo nunca é reenviado** | integração real: backend consome o refresh, A trava antes de persistir, B não chama `/auth/refresh` e exige novo login; `[postgres] instância que caiu…`; `[postgres] falha comprovadamente anterior ao envio…` |
| Publicação tardia | `updateTokens` exige ser o **dono do lease ainda válido** (`refresh_owner = dono AND refresh_lease_until > agora`) e nunca recria a linha. Quem perdeu a autoridade descarta o par, encerra a sessão e revoga o par recém-emitido no backend | integração real: A conclui no backend depois de perder o lease → 401 e o access token novo é recusado pelo backend; `[postgres] publicação tardia…` |
| Corridas login × logout | `publishLogin` e `endSessions` na mesma transação com `pg_advisory_xact_lock` | teste de estresse (40 iterações); **sem o bloqueio ele falha** em 3/3 execuções (mutação) |
| Isolamento entre usuários | id de 256 bits; linha por sessão; cifra amarrada à linha | `[postgres] isolamento…`; integração real |
| Tokens só no servidor | inalterado; banco só com cifras e hashes | `[postgres] em repouso…`; E2E `shared-sessions.spec.ts` |
| Armazenamento indisponível | 503 neutro; login revoga o par emitido; logout 503 sem fingir sucesso | `[postgres] armazenamento indisponível…` |

Relógio: as instâncias usam o relógio do processo (NTP); um desvio de segundos só desloca a expiração por inatividade nessa medida.

## 8. E-mail transacional

O fluxo SMTP existente (subprocesso com prazo, fila limitada, resposta neutra) foi mantido; só a
configuração hospedada passou a ser exigida. Para qualquer provedor com SMTP autenticado:
1. Conta do **projeto** no provedor (nunca credencial pessoal); credencial SMTP específica, com o menor
   escopo disponível; guardada só no gerenciador de segredos.
2. Domínio de envio verificado: registros **SPF**, **DKIM** e **DMARC** no DNS do domínio
   (valores fornecidos pelo provedor). Homologação pode usar um subdomínio próprio.
3. `EMAIL_FROM` com endereço desse domínio; `SMTP_SECURITY=starttls` (587) ou `tls` (465).
4. Confirme em homologação, com caixas da equipe, entrega, remetente, link e ausência de spam.

Depende da escolha do provedor: limites de envio, política de supressão/bounces, região dos dados,
custo. **Nada disso foi contratado ou configurado nesta etapa.**

Comportamento verificado localmente (testes existentes e ensaio §13): link apontando para
`PUBLIC_APP_ORIGIN` com token só no fragmento; expiração (`AUTH_PASSWORD_RESET_TTL_SECONDS`, 30 min) e
uso único; troca de senha encerra as sessões do backend **e**, consequentemente, as do BFF em todas as
instâncias; resposta idêntica para e-mail cadastrado e não cadastrado; nenhum token, senha ou e-mail
nos logs; provedor indisponível/timeout → 202 neutro e registro `delivery_error`/`timeout`, sem
repetição automática (doc 22, §12.5).

## 9. HTTPS, origens, proxy e limites de taxa

- **HTTPS** termina na borda da plataforma. O BFF recusa iniciar em staging/production com origem HTTP
  ou loopback; os cookies passam a `__Host-…; Secure`.
- **Origem**: `PRAZOAI_APP_ORIGIN` (BFF) = `PUBLIC_APP_ORIGIN` (backend). Toda mutação exige `Origin`
  igual a ela e o cabeçalho `x-prazoai-csrf`.
- **IP do cliente**: a borda deve **sobrescrever** um cabeçalho com o IP real (o nome depende da
  plataforma/CDN — escolha um que o visitante não consiga injetar). O BFF repassa esse valor ao backend
  com `X-PrazoAI-Proxy-Secret`; o backend ignora `X-Forwarded-For` e roda com `--no-proxy-headers`.
  **Validar na homologação** (§14, H5): um cabeçalho forjado pelo navegador não pode alterar o IP visto.
- **Limitadores de taxa** (cadastro, login, recuperação, redefinição, convites) ficam **em memória no
  backend**. Com a topologia proposta (uma instância, um worker, IP real via BFF) eles são globais e
  por cliente. Limitações aceitas e documentadas: (1) reinício do backend zera os contadores;
  (2) escalar o backend horizontalmente exigiria contadores compartilhados — por isso o startup recusa
  `WEB_CONCURRENCY≠1`, e a plataforma deve ser configurada com **uma** réplica (§9.1 — `WEB_CONCURRENCY` não limita réplicas); (3) a fila de
  recuperação também é por processo: pedidos enfileirados se perdem num reinício (o usuário pede de
  novo). O BFF pode ter várias instâncias: ele não aplica limites próprios.

### 9.1 Como limitar o backend a UMA réplica na plataforma

`WEB_CONCURRENCY=1` (e `--workers 1` no Dockerfile) limita os **workers dentro de um contêiner**; o
startup recusa outros valores. **Isso não impede a plataforma de executar várias réplicas do
contêiner** — cada réplica teria seus próprios limitadores e sua própria fila de e-mail, e os limites
por IP ficariam multiplicados pelo número de réplicas. O código não detecta réplicas paralelas; o
limite precisa ser configurado na plataforma:
1. **Número de instâncias fixo em 1** no serviço do backend (nome varia: *instances*, *replicas*,
   *min/max instances*, *scale count*). Mínimo = máximo = 1.
2. **Autoescala desligada** para o backend (ou máximo = 1). Não use “escalar para zero” se a
   plataforma recriar várias instâncias ao acordar.
3. **Estratégia de implantação**: se houver opção *recreate*/*stop-then-start*, use-a; com *rolling*
   ou *blue-green*, durante a troca a versão antiga e a nova coexistem por alguns segundos. Isso é
   aceitável (limites momentaneamente divididos; pedidos de recuperação na fila da versão antiga podem
   se perder — o usuário pede de novo), mas a sobreposição deve terminar quando o health check da nova
   versão passa.
4. **Sem réplicas regionais** do backend (multi-região) nem segundo serviço apontando para o mesmo banco.
5. **Verificação** (item H6b da §14): no painel da plataforma, exatamente 1 instância em execução fora
   das implantações; nos logs, um único `app_ready` por implantação e um único `dispatcher_started`;
   11 cadastros seguidos do mesmo IP → o 11º recebe 429 (com 2 réplicas, passaria).
O BFF não tem essa restrição: pode ter várias réplicas e autoescala.

## 10. Health checks e disponibilidade

| Alvo | Rota | Uso |
|---|---|---|
| Backend liveness | `GET /api/v1/health` | processo de pé (`storage`, `durable`) |
| Backend readiness | `GET /api/v1/health/ready` | banco, esquema (`0004`) e container de PDFs existente e privado (`checks.files`); 503 sem detalhes. **Use GET** (HEAD → 405) |
| BFF | `GET /bff/health` | configuração carregada + armazenamento de sessões acessível; **a versão do esquema `prazoai_bff` é consultada a cada chamada** (somente leitura; nunca cria nem migra). Esquema ausente ou em outra versão → 503 sem detalhes; volta a 200 quando o esquema correto for restaurado por migração explícita |
| Demo | `GET /` | página estática |

Configure a plataforma para só rotear tráfego após `ready`/`/bff/health` = 200.

## 11. Logs e monitoramento sem dados sensíveis

Os logs não contêm tokens, senhas, e-mails, ids de sessão nem URLs com credenciais (verificado no
ensaio §13.2 e nos testes de sensibilidade existentes). Eventos úteis para alertas:
- backend: `readiness_database_unavailable`, `readiness_schema_mismatch`,
  `email_send result=error|timeout|auth_error|tls_error|refused`, `recovery_item result=delivery_*`
  (ex.: `delivery_error`), `recovery_item_failed`, `recovery_worker_died`, `dispatcher_stop_unclean`,
  `email_smtp_reap_failed`, `http_error status=5xx` (contadores e categorias: doc 22, §10);
- BFF: `bff_session_store_unavailable`, `bff_session_store_error <código>`, `bff_session_undecryptable`,
  `bff_refresh_uncertain`, `bff_config_error`, `bff_unexpected_error`.
Alertas mínimos: health/readiness ≠ 200 por > 2 min; qualquer `bff_session_undecryptable`;
taxa de `delivery_error` > 0 em 15 min; 5xx acima do normal. Não habilite `LOG_LEVEL=DEBUG` nem
logs de corpo de requisição na plataforma; mascare a query string nos logs de acesso da borda (doc 22, §12.8).

## 12. Backup, restauração e chaves

1. **Backup**: backups automáticos do provedor (PITR, se disponível) + dump lógico diário do esquema
   do domínio: `pg_dump -Fc --no-owner --schema=prazoai -f prazoai-<data>.dump "<url do papel dono>"`.
   As sessões do BFF são efêmeras e **não** precisam de backup. **PDFs das intimações** (doc 28): ative
   soft delete/versionamento de blobs na conta de armazenamento; o banco guarda chave e SHA-256 de cada
   arquivo, o que permite conferir a restauração. Restaurar só o banco sem os blobs gera
   `intimation_file_missing` (502) nos downloads afetados.
2. **Restauração** (ensaiada localmente, §13.3): restaure num banco **novo** e confira antes de apontar a aplicação:
   ```bash
   createdb <banco_restaurado>
   pg_restore --no-owner --exit-on-error -d "<url do banco restaurado>" prazoai-<data>.dump
   python -m app.db check                      # revisão 0004
   ```
   Depois de restaurar, **encerre sessões e tokens** que podem ter sido revogados depois do backup:
   ```sql
   BEGIN; DELETE FROM prazoai.auth_sessions; DELETE FROM prazoai.password_reset_tokens; COMMIT;
   TRUNCATE prazoai_bff.sessions;
   ```
   Recrie os `GRANT` (§6.4) e aponte `DATABASE_URL`/`PRAZOAI_BFF_DATABASE_URL` para o banco restaurado.
3. **Rotação da chave de sessões do BFF**: defina a nova em `PRAZOAI_BFF_SESSION_KEY` e a antiga em
   `PRAZOAI_BFF_SESSION_KEY_PREVIOUS`; reimplante; após `PRAZOAI_BFF_SESSION_MAX_AGE_SECONDS` (7 dias),
   remova a anterior. Chave perdida/vazada: troque sem a anterior → todas as sessões do BFF caem (novo login).
4. **Rotação de `AUTH_JWT_SECRET`**: invalida access tokens (o BFF renova com o refresh). Vazamento de
   `TRUSTED_PROXY_SECRET`: troque nos dois serviços ao mesmo tempo.

## 13. Validação local executada (comandos e resultados reais)

Ambiente: WSL2 Ubuntu 24.04, Python 3.12.3, Node 22.23.5, PostgreSQL 16.15 em cluster **descartável**
próprio (porta 55432, `ssl=on` com CA local de teste), Mailpit v1.31.6 (SHA-256 conferido).
Nenhum banco compartilhado foi usado; todos os dados são fictícios.

### 13.1 Suítes
| Comando | Resultado |
|---|---|
| `pytest` (backend, PostgreSQL + Mailpit + PostgreSQL TLS obrigatórios) | **1080 aprovados, 1 pulado** (`test_storage_effective`: só roda no passo seguinte) — linha de base era 1023/1 |
| `PRAZOAI_TEST_STORAGE=postgres pytest <suítes HTTP do CI>` | **470 aprovados, 24 pulados** (todos marcados “específico do armazenamento em memória”) |
| `ruff check app tests migrations` · `mypy --no-incremental app` · `compileall` | sem erros |
| `npm test` (com `PRAZOAI_TEST_BFF_DATABASE_URL`, obrigatório) | **330 aprovados, 0 pulados** (linha de base 303) |
| `npm run typecheck` · `npm run lint` · `npm run build` (demo) | sem erros; demo servida (`/`, `/login`, `/app/dashboard` 200; `/bff/*` 404) |
| `npm run test:integration` (backend `STORAGE=memory`; inclui sessões compartilhadas e privilégios mínimos) | **54 aprovados, 0 pulados** |
| `npm run test:integration` (backend `STORAGE=postgres`) | **54 aprovados, 0 pulados** (banco recém-criado); dados persistidos conferidos |
| `npm run test:e2e` (Chromium; FastAPI em PostgreSQL; Mailpit; sessões do BFF no PostgreSQL) | **70 aprovados, 0 pulados** |
| CLI `bff:sessions` (check → migrate sem confirmação → migrate → check; banco fora do ar) | 4 → 2 → 0 → 0; 5 |
| Papéis separados com privilégios mínimos (`least-privilege-backend.test.mjs`, PostgreSQL descartável) | **3/3**; banco e papéis temporários removidos ao final |

Revisão do PR #35: os testes de renovação incerta (backend real consumindo o refresh) e de health com
esquema alterado **falhavam** no código anterior e passam com a correção. Mutações que reintroduzem
cada defeito (lease vencido adquirível, publicação sem autoridade, health só com `SELECT 1`) são
detectadas. Mutações anteriores para conferir que os testes novos detectam falhas reais: lease sempre concedido → 3 testes
falham; publicação de login ignorando o bilhete → 1 falha; encerramento sem bloqueio consultivo → o
teste de estresse falha em 3/3 execuções.

### 13.2 Ensaio da configuração hospedada (staging real, sem exceções de desenvolvimento)
Backend `ENVIRONMENT=staging` (mesmos argumentos do `CMD` do Dockerfile), PostgreSQL com
`sslmode=verify-full`, SMTP com STARTTLS obrigatório + AUTH num IP não-loopback com CA verificada;
duas instâncias do BFF em `PRAZOAI_APP_ENV=staging` com sessões no PostgreSQL (`verify-full`):
1. migration sem `PRAZOAI_CONFIRM_MIGRATION_TARGET` recusada; com ela, aplicada; `app.db check` = 0003;
2. startup recusado sem credenciais SMTP e com `WEB_CONCURRENCY=2` (mensagem sem valores);
3. `/api/v1/health` e `/ready` 200; `/docs`, `/redoc`, `/openapi.json` 404; sem cabeçalho `Server`;
4. BFF recusa sessões em memória e banco sem TLS;
5. cadastro/login: cookie `__Host-prazoai_sid_*; HttpOnly; SameSite=Strict; Secure`, sem `Domain`; Origin alheia → 403;
6. sessão criada em A lida em B; valor do cookie ausente do banco;
7. recuperação: 202 idêntico para e-mail cadastrado e não cadastrado; exatamente 1 mensagem; link
   `https://<origem pública>/redefinir-senha#<token>`;
8. redefinição encerra a sessão em A e B; token de uso único; senha antiga 401; nova senha 200; logout em A encerra em B;
9. logs do backend: 0 ocorrências de token, senhas, e-mail ou senha SMTP;
10. provedor SMTP fora do ar: 202 neutro, `delivery_error` registrado, readiness continua 200.

### 13.3 Backup e restauração
`pg_dump -Fc --schema=prazoai` → `pg_restore` em banco novo: mesma revisão (0003) e contagens;
encerramento pós-restauração executado; `app.db check` = 0003.

## 14. Validação obrigatória na homologação (dados fictícios, acesso restrito)

| # | Verificação | Como |
|---|---|---|
| H1 | Startup recusado com configuração incompleta | remova uma variável obrigatória num deploy de teste; o serviço não sobe e o log lista o requisito |
| H2 | Migrations e esquema | §6.2–6.3; `/api/v1/health/ready` e `/bff/health` = 200 |
| H3 | Papéis com privilégio mínimo | §6.4 (arquivo `backend/deploy/privilegios-minimos.sql`); BFF e backend funcionam; o papel do BFF **não** lê `prazoai.users`; o da API não lê `prazoai_bff.sessions` |
| H4 | HTTPS e cookies | DevTools: cookie `__Host-…; Secure; HttpOnly; SameSite=Strict`; HTTP redireciona para HTTPS |
| H5 | IP real do cliente | dois aparelhos/redes: limites de cadastro independentes; enviar o cabeçalho de IP forjado pelo navegador **não** muda o IP (11º cadastro do mesmo IP → 429) |
| H6 | Várias instâncias do BFF | escalar para 2; login, navegação e logout alternando instâncias; reiniciar uma instância sem perder a sessão |
| H6b | Backend com uma réplica | §9.1: painel com 1 instância, autoescala desligada; um `app_ready` por implantação; 11º cadastro do mesmo IP → 429 |
| H7 | E-mail real | recuperação para caixas da equipe: entrega, SPF/DKIM/DMARC “pass” nos cabeçalhos, link na origem pública, expiração (30 min) e uso único |
| H8 | Fluxos do produto | cadastro, login, pessoal × escritório, convite, permissões de leitura/edição, prazos, calendário, intimações — roteiro dos docs 11, 12, 14 e 26 |
| H9 | Isolamento | duas contas fictícias: nenhuma vê dados da outra; membro sem permissão não edita |
| H10 | Backup e restauração | §12.2 num banco temporário do provedor |
| H11 | Logs e alertas | §11: nenhum dado sensível; alertas disparam ao derrubar o banco de homologação |
| H12 | Rollback | §16 com uma versão anterior da imagem |
| H13 | Demo intacta | URL pública da demo continua servindo o protótipo sem BFF |

## 15. Critérios objetivos para liberar contas reais

Todos precisam ser verdadeiros, com evidência registrada (data, SHA implantado, responsável):
1. CI verde no GitHub para o SHA a implantar (incluindo os jobs novos desta entrega).
2. H1–H13 aprovados na homologação, no **mesmo SHA**.
3. Produção com banco, segredos e credenciais **próprios** (nada reutilizado da homologação).
4. Domínio de e-mail com SPF, DKIM e DMARC válidos; entrega confirmada em produção para caixa da equipe.
5. Backup automático ativo e **uma restauração testada** (§12.2) com data registrada.
6. Alertas mínimos (§11) ativos e testados.
7. Backend configurado na plataforma com exatamente 1 réplica, autoescala desligada (§9.1) e 1 worker; BFF com sessões no PostgreSQL.
8. Termos de uso e política de privacidade publicados (LGPD) — **fora do escopo técnico desta entrega**.
9. Plano de rollback (§16) ensaiado na homologação.

## 16. Rollback e compatibilidade das migrations

- **Esquema do domínio**: revisão exigida pelo código = `0004` (doc 28; o app recusa iniciar com outra).
  **Voltar só a imagem anterior não basta** depois da 0004: ela exige o esquema 0003 e recusa iniciar.
  O downgrade 0004 → 0003 é **recusado** enquanto houver intimação com PDF armazenado; para esse caso
  há um rollback de emergência testado (preparar → downgrade → imagem anterior; e, para voltar,
  upgrade → restaurar): **doc 28, §10**, scripts em `backend/deploy/rollback-0004-*.sql`.
  Registro histórico da entrega anterior:
  Esta entrega **não** cria migration nova do domínio; voltar para o SHA anterior (`1d6d7fc`) não exige
  downgrade — mas o código anterior **recusa** `ENVIRONMENT=staging|production` com PostgreSQL (é o
  bloqueio removido aqui), então o rollback em ambiente hospedado é para **uma versão anterior desta
  linha** (outro SHA já validado), não para `1d6d7fc`.
- **Esquema `prazoai_bff`**: versão 1, aditiva e isolada; versões anteriores do BFF simplesmente não o usam.
- **Procedimento**: (1) reimplante a imagem/SHA anterior validado em ambos os serviços; (2) confira
  `/ready` e `/bff/health`; (3) **não** rode `alembic downgrade` em produção sem backup recente e
  janela de manutenção — downgrades removem colunas/tabelas (perda de dados); prefira correção para frente;
  (4) se a chave de sessão mudou entre versões, mantenha-a em `PRAZOAI_BFF_SESSION_KEY_PREVIOUS`.
- **Regras para migrations futuras**: sempre expandir → implantar → contrair (colunas novas opcionais
  primeiro; remoções só depois que nenhuma versão em execução as usa); backup imediatamente antes;
  aplicar em homologação primeiro.
- Fora de produção, o CI continua exercitando `upgrade`/`downgrade` completos (0004 → 0003 → 0002 → 0001 → head).

## 17. Identificação da entrega (SHA)

| Referência | SHA |
|---|---|
| `main` local e `origin/main` no início | `1d6d7fc4e7eef5d9c7801c17f2c9c3fd65a1a611` |
| PR #34 (README, aberto, não tocado) | `64eda61d22e27c15c25a7031d34351e0ef094e02` |
| Commit inicial desta entrega | `5c49a63de1a63ec01e079bd7f5a3726f1abfc8f4` |
| SHA final desta entrega | o último commit da branch `feature/implantacao-homologacao` (PR #35, rascunho): `git rev-parse origin/feature/implantacao-homologacao` |

Conferência: no VS Code (linha do tempo do arquivo ou `git log -1`), no GitHub depois do push
autorizado (o SHA da branch deve ser idêntico ao local) e no deploy (registre o SHA implantado nas
variáveis/etiquetas da plataforma e compare com este).

## 18. Limitações conhecidas desta entrega

- Renovação: se uma instância cair (ou não conseguir gravar) depois de enviar o refresh, a sessão
  afetada é encerrada e o usuário entra de novo — não há como recuperar o par emitido. Quando a
  instância caiu, o par novo fica sem dono no backend até expirar (a revogação do access token antigo
  é melhor tentativa: ele pode já ter vencido). Uma queda entre obter o lease e enviar a requisição
  também é tratada como incerta (encerramento conservador). A decisão usa o relógio das instâncias
  (NTP): o lease tem `PRAZOAI_BFF_TIMEOUT_MS + 5 s`.

- Imagens Docker não foram construídas localmente (Docker indisponível no WSL); o job `docker` do CI
  as constrói e exercita sem publicar (resultado no PR #35).
- O código não detecta réplicas paralelas do backend; a réplica única depende da configuração da
  plataforma (§9.1).
- Entrega por provedor real, SPF/DKIM/DMARC, IP real atrás da borda e backups gerenciados só podem ser
  validados no ambiente hospedado (§14).
- Limitadores e fila de recuperação seguem por processo (§9), aceitável só com uma instância do backend.
