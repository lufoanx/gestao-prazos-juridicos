# 27 — Implantação: homologação, produção e rollback

> **Situação desta entrega:** **implementado e testado localmente** (recursos descartáveis, dados
> fictícios). **Nada foi implantado.** O sistema **não está validado para uso real**: os itens da §14
> só podem ser cumpridos no ambiente hospedado, com provedor de e-mail, domínio e banco definidos
> pelo responsável do projeto. Os critérios objetivos para liberar contas reais estão na §15.

Base: `main` em `1d6d7fc` (igual a `origin/main` no início do trabalho). Branch: `feature/implantacao-homologacao`.
O SHA final desta entrega é o do commit que adiciona este arquivo (§17).

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
integração e no E2E, PostgreSQL com TLS para os testes de ambiente hospedado. **Não executado no
GitHub nesta etapa** (nenhum push): ver §16.

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
- **Backend**: **uma** instância com **um** worker (§9). Preferencialmente sem rota pública (rede
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
   ENVIRONMENT=staging DATABASE_URL=... python -m app.db check      # deve mostrar "revisão do esquema: 0003"
   ```
3. Esquema das sessões do BFF — com o papel dono:
   ```bash
   cd frontend
   PRAZOAI_BFF_DATABASE_URL='postgresql://prazoai_owner:<senha>@<host>:5432/prazoai_homolog?sslmode=verify-full' \
   PRAZOAI_BFF_CONFIRM_TARGET='<host>:5432/prazoai_homolog' npm run bff:sessions -- migrate
   npm run bff:sessions -- check                                      # "versão do esquema prazoai_bff: 1"
   ```
4. Privilégios mínimos (o BFF **não** acessa o domínio; o backend **não** acessa as sessões do BFF):
   ```sql
   GRANT USAGE ON SCHEMA prazoai TO prazoai_api;
   GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA prazoai TO prazoai_api;
   GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA prazoai TO prazoai_api;
   GRANT USAGE ON SCHEMA prazoai_bff TO prazoai_bff_app;
   GRANT SELECT, INSERT, UPDATE, DELETE ON prazoai_bff.sessions TO prazoai_bff_app;
   GRANT SELECT ON prazoai_bff.schema_version TO prazoai_bff_app;
   REVOKE ALL ON SCHEMA prazoai FROM prazoai_bff_app;
   REVOKE ALL ON SCHEMA prazoai_bff FROM prazoai_api;
   ```
   Repita os `GRANT` de tabelas depois de migrations que criem tabelas novas.
   **Não verificado localmente:** os testes desta entrega usaram um único papel; confira na homologação
   que backend e BFF funcionam com estes privilégios (item H3 da §14).
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
| Renovação concorrente | **lease por geração** (`UPDATE … WHERE refresh_lease_until <= now`); outras instâncias aguardam a troca de geração; lease vence se a instância cair | `[postgres] renovação concorrente…` (1 refresh), integração real sem detecção de reutilização |
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
  `WEB_CONCURRENCY≠1`, e a plataforma deve ser configurada com **uma** instância; (3) a fila de
  recuperação também é por processo: pedidos enfileirados se perdem num reinício (o usuário pede de
  novo). O BFF pode ter várias instâncias: ele não aplica limites próprios.

## 10. Health checks e disponibilidade

| Alvo | Rota | Uso |
|---|---|---|
| Backend liveness | `GET /api/v1/health` | processo de pé (`storage`, `durable`) |
| Backend readiness | `GET /api/v1/health/ready` | banco e esquema (`0003`); 503 sem detalhes. **Use GET** (HEAD → 405) |
| BFF | `GET /bff/health` | configuração carregada + armazenamento de sessões acessível (conexão e versão `prazoai_bff`) |
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
   As sessões do BFF são efêmeras e **não** precisam de backup.
2. **Restauração** (ensaiada localmente, §13.3): restaure num banco **novo** e confira antes de apontar a aplicação:
   ```bash
   createdb <banco_restaurado>
   pg_restore --no-owner --exit-on-error -d "<url do banco restaurado>" prazoai-<data>.dump
   python -m app.db check                      # revisão 0003
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
| `npm test` (com `PRAZOAI_TEST_BFF_DATABASE_URL`, obrigatório) | **327 aprovados, 0 pulados** (linha de base 303) |
| `npm run typecheck` · `npm run lint` · `npm run build` (demo) | sem erros; demo servida (`/`, `/login`, `/app/dashboard` 200; `/bff/*` 404) |
| `npm run test:integration` (backend `STORAGE=memory`) | **49 aprovados, 0 pulados** |
| `npm run test:integration` (backend `STORAGE=postgres`) | **49 aprovados, 0 pulados**; dados persistidos conferidos |
| `npm run test:e2e` (Chromium; FastAPI em PostgreSQL; Mailpit; sessões do BFF no PostgreSQL) | **70 aprovados, 0 pulados** |
| CLI `bff:sessions` (check → migrate sem confirmação → migrate → check; banco fora do ar) | 4 → 2 → 0 → 0; 5 |

Mutações para conferir que os testes novos detectam falhas reais: lease sempre concedido → 3 testes
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
| H3 | Papéis com privilégio mínimo | §6.4; BFF e backend funcionam; o papel do BFF **não** lê `prazoai.users` |
| H4 | HTTPS e cookies | DevTools: cookie `__Host-…; Secure; HttpOnly; SameSite=Strict`; HTTP redireciona para HTTPS |
| H5 | IP real do cliente | dois aparelhos/redes: limites de cadastro independentes; enviar o cabeçalho de IP forjado pelo navegador **não** muda o IP (11º cadastro do mesmo IP → 429) |
| H6 | Várias instâncias do BFF | escalar para 2; login, navegação e logout alternando instâncias; reiniciar uma instância sem perder a sessão |
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
7. Backend configurado com exatamente 1 instância/worker; BFF com sessões no PostgreSQL.
8. Termos de uso e política de privacidade publicados (LGPD) — **fora do escopo técnico desta entrega**.
9. Plano de rollback (§16) ensaiado na homologação.

## 16. Rollback e compatibilidade das migrations

- **Esquema do domínio**: revisão exigida pelo código = `0003` (o app recusa iniciar com outra).
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
- Fora de produção, o CI continua exercitando `upgrade`/`downgrade` completos (0003 → 0001 → head).

## 17. Identificação da entrega (SHA)

| Referência | SHA |
|---|---|
| `main` local e `origin/main` no início | `1d6d7fc4e7eef5d9c7801c17f2c9c3fd65a1a611` |
| PR #34 (README, aberto, não tocado) | `64eda61d22e27c15c25a7031d34351e0ef094e02` |
| Commit desta entrega (local, **não publicado**) | o commit que adiciona este arquivo: `git log -1 --format=%H -- docs/backend/27-implantacao-homologacao-producao.md` |

Conferência: no VS Code (linha do tempo do arquivo ou `git log -1`), no GitHub depois do push
autorizado (o SHA da branch deve ser idêntico ao local) e no deploy (registre o SHA implantado nas
variáveis/etiquetas da plataforma e compare com este).

## 18. Limitações conhecidas desta entrega

- Imagens Docker **não foram construídas** localmente (Docker indisponível no WSL); os comandos de
  execução do `CMD` foram exercitados diretamente.
- O CI alterado **não rodou no GitHub** (nenhum push). O passo de PostgreSQL com TLS usa `docker run`
  no runner e precisa ser confirmado na primeira execução.
- Privilégios mínimos (§6.4) não foram exercitados com papéis separados.
- Entrega por provedor real, SPF/DKIM/DMARC, IP real atrás da borda e backups gerenciados só podem ser
  validados no ambiente hospedado (§14).
- Limitadores e fila de recuperação seguem por processo (§9), aceitável só com uma instância do backend.
