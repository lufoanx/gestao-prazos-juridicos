# 22 — Operação da recuperação de senha (guia local e observabilidade)

> **Tipo de entrega:** DOCUMENTAÇÃO (E6 do doc 21). Nenhum código, dependência, migration ou CI foi
> alterado. Nenhum provedor foi configurado, nenhuma credencial foi pedida e nenhum e-mail externo foi
> enviado. **Produção continua bloqueada por código** (§15).
>
> **Base:** `main` `3e1682b62890d339f3290c495e2ad8a86d325abc` (merge do PR #27), árvore
> `69ede9bc73ddb9c5ca29242d74e81d3ce6915c42`. O CI pós-merge `44194894812` passou nos quatro jobs
> (estrutura, frontend, backend e integração com E2E). Esse CI valida o **código da base**; não
> confere este documento. A conferência do documento está em §18.

**Como ler.** Este guia descreve o que **existe hoje** e como operar localmente. O
[doc 21](21-projeto-email-recuperacao.md) guarda o histórico: as seções 1 a 13 são o **projeto
original** (decisões e propostas, algumas depois ajustadas) e as seções 14 a 23 registram o que cada
entrega implementou e corrigiu. Quando houver diferença, vale o código atual e este guia.

Convenções: **[EXECUTADO]** = comando rodado nesta entrega, em recursos locais descartáveis;
**[LIDO]** = conferido só contra o código ou a configuração; **[PENDENTE]** = não existe hoje.

---

## 1. Mapa dos componentes

| Componente | Onde | Responsabilidade |
|---|---|---|
| Tela `/esqueci-senha` | `frontend/src/integrated/RecoveryScreens.tsx`, `useRecoveryFlows.ts` | consulta a disponibilidade, envia o pedido, mostra sempre a mesma resposta neutra |
| Tela `/redefinir-senha#TOKEN` | idem + `src/lib/integration/reset-controller.mjs`, `fragment-token.mjs` | lê o token do fragmento, remove-o da barra, guarda-o só em memória, envia a nova senha |
| Página do link antigo | `frontend/src/app/redefinir-senha-antigo/page.tsx` + `src/middleware.ts` | `/redefinir-senha/<qualquer coisa>` → página estática, sem eco, com `Referrer-Policy: no-referrer` |
| Cliente público | `src/lib/integration/recovery-client.mjs` | só as três rotas públicas do BFF; token e senha só no corpo |
| BFF (rotas públicas) | `frontend/src/server/bff/public-recovery.mjs` | CSRF e `Origin`, corpo exato, destino fixo, `no-store`, sem cookies; timeout → resultado desconhecido |
| API FastAPI | `backend/app/api/auth.py` | `GET /api/v1/auth/password-recovery/status`, `POST /forgot-password`, `POST /reset-password` |
| Serviço de autenticação | `backend/app/services/auth_service.py` | disponibilidade, limites por IP e por e-mail, admissão na fila; redefinição atômica |
| `RecoveryDispatcher` | `backend/app/recovery/dispatcher.py` | fila **em memória**, limitada, com prazo; **um** worker; encerramento com orçamento |
| Processador | `backend/app/recovery/processor.py` | por pedido: busca a conta → emite o token (só o hash vai ao banco) → uma tentativa de entrega |
| Composer | `backend/app/email/composer.py` | monta o e-mail com `PUBLIC_APP_ORIGIN/redefinir-senha#TOKEN`, "gerado em" e "válido até" |
| Transporte SMTP | `backend/app/email/smtp_subprocess.py` + `smtp_child.py` | um **subprocesso** por envio, supervisionado (prazo, `SIGTERM`, `SIGKILL`, coleta) |
| PostgreSQL | tabela `prazoai.password_reset_tokens` (e usuários, sessões) | tokens (hash), credenciais, sessões; conexão exclusiva do worker |
| Manutenção | `backend/app/maintenance/` | remove tokens usados, invalidados ou expirados (P5) |
| Capturador local | Mailpit `v1.31.6` (`backend/test-infra/mailpit/compose.yaml`) | recebe e guarda os e-mails **sem repassá-los**; só desenvolvimento e testes |

## 2. Caminho completo, do pedido à redefinição

```
navegador ──POST /bff/public/password/forgot──▶ BFF ──POST /api/v1/auth/forgot-password──▶ FastAPI
                                                        disponibilidade → limite por IP → limite por e-mail
                                                        → fila em memória → 202 neutro (sem banco, sem SMTP)
worker (thread única) ── retira da fila ── busca a conta ── emite o token (COMMIT) ── composer
        └─ subprocesso SMTP ──▶ servidor SMTP (local: Mailpit) ──▶ caixa de entrada
pessoa abre o link /redefinir-senha#TOKEN ── a página lê e apaga o fragmento ── nova senha
navegador ──POST /bff/public/password/reset {token, newPassword}──▶ BFF ──▶ FastAPI
        consome o token, troca a senha, invalida os demais tokens e revoga as sessões → 204
```

1. A tela consulta `GET /bff/public/password/status`, que só responde `{ available }`.
2. O pedido chega ao FastAPI, que verifica **na ordem**: disponibilidade (senão 503
   `password_recovery_unavailable`), limite por IP, limite por e-mail (429 com `Retry-After`) e
   admissão na fila. Nada consulta o banco, emite token ou fala com o SMTP no caminho da requisição.
   A resposta é **202 neutro** para conta existente, inexistente ou fila cheia.
3. O worker retira o pedido (descarta se esperou ≥ `RECOVERY_QUEUE_MAX_WAIT_SECONDS`), busca a conta
   (inexistente → fim, sem e-mail), emite um token novo (o anterior da mesma conta é invalidado) e faz
   **uma** tentativa de envio, depois do COMMIT. Não há repetição automática.
4. O link usa a origem configurada (`PUBLIC_APP_ORIGIN`), nunca o `Host` da requisição. O token fica
   no **fragmento** (`#`), que o navegador não envia ao servidor.
5. A página `/redefinir-senha` lê o fragmento, apaga-o da barra com `history.replaceState` e guarda o
   token só em memória. Recarregar a página perde o token: é preciso abrir o link de novo.
6. A redefinição consome o token, troca a senha, invalida os outros tokens e **revoga as sessões**.
   Não há login automático; sessões antigas descobrem a revogação no próximo uso (401 → login).

## 3. Quatro marcos que não podem ser confundidos

| Marco | O que significa | Evidência hoje | O que **não** prova |
|---|---|---|---|
| Pedido aceito | 202 neutro: o pedido entrou na fila (ou foi descartado por fila cheia, ou a conta não existe) | resposta HTTP 202; log de acesso do uvicorn | que a conta existe, que haverá token ou e-mail |
| Token emitido | o worker criou o token e confirmou no banco | indireta: `recovery_item … result=delivery_*` ou `stopped_after_issue` | que algum e-mail saiu |
| Mensagem aceita pelo SMTP | o servidor SMTP respondeu "aceito" | `email_send result=accepted` e `recovery_item … result=delivery_accepted` | que a mensagem chegou à caixa (o servidor ainda pode recusar, atrasar ou filtrar) |
| Chegada à caixa | a pessoa vê o e-mail | **nenhuma** na aplicação; localmente, o Mailpit mostra a mensagem | — (com provedor real, dependeria de recursos do provedor: [PENDENTE]) |

O Mailpit **aceita tudo e não entrega nada**: "chegou ao Mailpit" equivale a "aceito pelo SMTP" num
servidor local, não a entrega por um provedor externo.

## 4. Modos de operação

| Modo | Como se obtém | Telas | API |
|---|---|---|---|
| **Demonstrativo** | frontend com `NEXT_PUBLIC_PRAZOAI_MODE` vazio ou `demo` (fixado no build) | simuladas; link demonstrativo `/redefinir-senha#demo` (`#expirado`, `#usado`); nada é enviado | não usada |
| **Integrado, recuperação desabilitada** | `NEXT_PUBLIC_PRAZOAI_MODE=integrated`; backend com `EMAIL_TRANSPORT=disabled` (**padrão**) | `/esqueci-senha` mostra "Recuperação indisponível", sem formulário | `status` → `{"available":false}`; `forgot-password` → **503** `password_recovery_unavailable`; nenhum token |
| **Integrado com Mailpit** | backend com `EMAIL_TRANSPORT=smtp` apontando ao capturador local (§7) | fluxo completo | `status` → `{"available":true}`; e-mails ficam no capturador |

[EXECUTADO] Nos três modos integrados acima o comportamento foi observado localmente (§18).

## 5. Plataforma

- `EMAIL_TRANSPORT=smtp` é suportado **somente em Linux, inclusive em contêiner Linux**: o transporte
  usa grupos de processos, `SIGTERM`/`SIGKILL` e o módulo `resource`. Em outra plataforma a aplicação
  **não inicia** com `smtp` (`UnsupportedPlatformError`, em `app/email/transport.py`) [LIDO].
- **Windows nativo não é suportado** para o envio. Lá, use `EMAIL_TRANSPORT=disabled` (a recuperação
  fica indisponível) ou rode o backend num contêiner ou máquina Linux. Outros ambientes, como WSL,
  não foram verificados.
- O modo `disabled` funciona em qualquer plataforma.

## 6. Papel do PostgreSQL, do BFF e do capturador

- **PostgreSQL** (`STORAGE=postgres`, só `development`/`test` nesta fase): guarda usuários,
  credenciais, sessões e tokens de recuperação (**só o hash SHA-256** do token). O worker usa uma
  **conexão exclusiva** (engine próprio, sem pool), com `RECOVERY_DB_LOCK_TIMEOUT_MS` e
  `RECOVERY_DB_STATEMENT_TIMEOUT_MS`. Com `STORAGE=memory`, tudo isso vive no processo e se perde no
  reinício. **A fila e os limites de taxa são sempre em memória**, nos dois modos.
- **BFF** (Next.js): o navegador nunca fala com o FastAPI. As rotas públicas exigem o cabeçalho
  `x-prazoai-csrf: 1` (também no `GET`) e, nas mutações, `Origin` igual a `PRAZOAI_APP_ORIGIN`;
  aceitam só o corpo exato; nunca leem nem criam cookies; respondem `no-store`. Timeout depois do
  envio vira **504 `outcome: "unknown"`**, sem nova tentativa.
- **Capturador (Mailpit)**: servidor SMTP local que guarda as mensagens. Sem relay configurado, nada
  sai dele. A interface mostra os **links com token**: é tão sensível quanto as senhas da demonstração.

## 7. Configuração

Valores conferidos em `backend/app/core/config.py`, `backend/app/email/config.py` e
`frontend/src/server/bff/config.mjs` [LIDO]. Todos os exemplos são fictícios.

### 7.1 Backend — e-mail e transporte
| Variável | Padrão (faixa) | Regras |
|---|---|---|
| `EMAIL_TRANSPORT` | `disabled` | `disabled` ou `smtp`; outro valor impede a inicialização |
| `PUBLIC_APP_ORIGIN` | — | obrigatória com `smtp`; só esquema, host e porta; `https`, exceto `http` em loopback com `ENVIRONMENT` `development`/`test` |
| `EMAIL_FROM` | — | obrigatório com `smtp`; **um** endereço válido, sem CR/LF. No shell, use aspas: `EMAIL_FROM="PrazoAI <nao-responda@exemplo.com>"` |
| `SMTP_HOST` / `SMTP_PORT` | — / `587` (1–65535) | host obrigatório com `smtp` |
| `SMTP_SECURITY` | `starttls` | `starttls`, `tls` (implícito) ou `none`; a verificação de certificado e nome é sempre obrigatória com TLS |
| `SMTP_ALLOW_INSECURE_LOCAL` | `false` | exigida para `none` |
| `SMTP_USERNAME` / `SMTP_PASSWORD` | — | os dois juntos ou nenhum; **proibidos com `none`**; a senha nunca aparece em erros ou logs |
| `SMTP_CA_FILE` | — | CA adicional confiável (relay privado ou testes); não desliga a verificação |
| `SMTP_TIMEOUT_SECONDS` | `10` (2–30) | cada operação dentro do filho |
| `SMTP_SEND_DEADLINE_SECONDS` | `30` (5–120) | prazo total da comunicação com o filho; vencido → `deadline_killed` (entrega **incerta**) |
| `SMTP_TERM_GRACE_SECONDS` | `1` (0,1–10) | tolerância ao `SIGTERM` |
| `SMTP_REAP_TIMEOUT_SECONDS` | `2` (0,5–10) | coleta do filho; vencida → transporte indisponível até reiniciar |

**Exceção sem TLS (`SMTP_SECURITY=none`)**: só é aceita com as **quatro** condições juntas —
`SMTP_ALLOW_INSECURE_LOCAL=true`, `SMTP_HOST` de loopback (`localhost`, `127.0.0.1`, `::1`),
`ENVIRONMENT` `development` ou `test`, e **sem** credenciais. Serve apenas para o capturador local.

### 7.2 Backend — fila, limites, encerramento e banco
| Variável | Padrão (faixa) | Efeito |
|---|---|---|
| `RECOVERY_QUEUE_MAX` | `100` (10–10000) | fila cheia → pedido descartado e contado; resposta 202 igual |
| `RECOVERY_QUEUE_MAX_WAIT_SECONDS` | `60` (10–600) | pedido que esperou isso ou mais é descartado **antes** de consultar o banco |
| `RECOVERY_SHUTDOWN_GRACE_SECONDS` | `5` (1–60) | orçamento **total** do encerramento do despachante |
| `RECOVERY_DB_LOCK_TIMEOUT_MS` / `RECOVERY_DB_STATEMENT_TIMEOUT_MS` | `1000` (100–30000) / `3000` (500–60000) | conexão exclusiva do worker; o primeiro não pode exceder o segundo |
| `AUTH_FORGOT_IP_MAX_REQUESTS` / `AUTH_FORGOT_IP_WINDOW_SECONDS` | `10` / `900` | pedidos por IP |
| `AUTH_FORGOT_MAX_REQUESTS` / `AUTH_FORGOT_WINDOW_SECONDS` | `3` / `900` | pedidos por e-mail (destinatário) |
| `AUTH_RESET_MAX_REQUESTS` / `AUTH_RESET_WINDOW_SECONDS` | `10` / `900` | tentativas de redefinição por IP (antes de qualquer hash de senha) |
| `AUTH_PASSWORD_RESET_TTL_SECONDS` | `1800` (300–86400) | validade do token |
| `AUTH_RATE_LIMIT_MAX_KEYS` | `10000` | teto de chaves por limitador |
| `TRUSTED_PROXY_SECRET` | vazio (mín. 32 bytes) | só com ele o backend aceita o IP do cliente informado pelo BFF |
| `DATABASE_*` | ver `backend/README.md` | pool e prazos da API (o worker usa os seus) |
| `LOG_LEVEL` | `INFO` | os registros por pedido (§10.1) são `INFO`: com `WARNING` eles somem |

Relações que o código **não** verifica entre processos:
- `PUBLIC_APP_ORIGIN` (backend) deve ser **igual** a `PRAZOAI_APP_ORIGIN` (BFF). Diferentes, o link
  do e-mail leva a outro endereço.
- Sem `TRUSTED_PROXY_SECRET` igual a `PRAZOAI_PROXY_SECRET` **e** um
  `PRAZOAI_TRUSTED_CLIENT_IP_HEADER` sobrescrito pela infraestrutura, o backend vê o IP do BFF: o
  limite por IP passa a ser **compartilhado por todos** os usuários. Aceitável localmente; em produção
  é item de prontidão (§15).
- Com um só worker, um envio lento atrasa os seguintes: dois envios que vencem
  `SMTP_SEND_DEADLINE_SECONDS` (30 s) já fazem o próximo passar de `RECOVERY_QUEUE_MAX_WAIT_SECONDS`
  (60 s) e ser descartado.
- `RECOVERY_SHUTDOWN_GRACE_SECONDS` (5 s) é menor que o prazo de envio: um encerramento durante um
  envio cancela o filho (entrega incerta).

### 7.3 BFF (frontend, só servidor)
| Variável | Padrão (faixa) | Regras |
|---|---|---|
| `NEXT_PUBLIC_PRAZOAI_MODE` | demo | `integrated` liga o BFF; fixado **no build** |
| `PRAZOAI_APP_ENV` | `production` | `development`, `test` ou `production` (independe de `NODE_ENV`) |
| `PRAZOAI_APP_ORIGIN` | — (obrigatória) | só a origem; `http` exige `PRAZOAI_COOKIE_INSECURE_LOCAL=true`, loopback e ambiente diferente de `production` |
| `PRAZOAI_BACKEND_URL` | `http://127.0.0.1:8000` | destino fixo do BFF |
| `PRAZOAI_BFF_TIMEOUT_MS` | `10000` (100–60000) | depois disso, mutação = resultado desconhecido (504) |
| `PRAZOAI_BFF_MAX_BODY_BYTES` | `65536` | corpo maior → 413 |
| `PRAZOAI_PROXY_SECRET` / `PRAZOAI_TRUSTED_CLIENT_IP_HEADER` | vazios | ver relação acima; `X-Forwarded-For` e `Forwarded` são recusados como cabeçalho confiável |
| `PRAZOAI_BFF_*` (sessões) | ver `frontend/.env.example` | sessões do BFF **em memória**, um processo Node |

## 8. Ambiente mínimo do subprocesso SMTP

Cada envio cria um filho `python -I smtp_child.py` com `cwd="/"`, descritores fechados, sessão de
processo própria e ambiente **mínimo**: `PATH=/usr/bin:/bin`, `LANG=C.UTF-8`, `LC_ALL=C.UTF-8`.
Configuração, credenciais e a mensagem (com o token) vão **só pela entrada padrão**; nada vai em
argumentos, arquivos ou variáveis de ambiente. Nenhuma variável do processo pai é herdada
(nem `DATABASE_URL`, nem segredos) [LIDO].

**Correção da `libpython` compartilhada** (doc 21, §21): interpretadores compilados com `libpython`
compartilhada e instalados fora do caminho de compilação (caso do `actions/setup-python` dentro de um
contêiner) não encontravam a biblioteca com o ambiente mínimo e saíam com código 127 antes de rodar
qualquer código. Agora, **só** quando o filho é o próprio interpretador em uso e ele depende dessa
biblioteca, o filho recebe também `LD_LIBRARY_PATH` com **um único diretório**: o da `libpython` que o
processo atual realmente carregou (`/proc/self/maps`). O `LD_LIBRARY_PATH` do pai não é repassado.

## 9. Execução local

### 9.0 Convenções (leia antes de copiar comandos)
- **Diretório inicial.** Cada bloco começa com `cd "<raiz>"`, a pasta do clone que contém `backend/` e
  `frontend/`. Os blocos não dependem do diretório em que outro bloco terminou.
- **Terminais independentes.** Variáveis exportadas num terminal **não existem** nos outros. Por isso
  cada terminal define todas as variáveis de que precisa, inclusive `DATABASE_URL`.
- **Substituições.** Troque, antes de executar:
  - `<raiz>`: caminho do clone (ex.: `/home/ana/gestao-prazos-juridicos`);
  - `<usuário-pg>`: usuário do **seu** PostgreSQL local de desenvolvimento;
  - `<caminho-do-mailpit>`: pasta onde você extraiu o binário oficial (só na alternativa sem Docker);
  - `localhost`/`5432`: host e porta do seu PostgreSQL, se forem outros.
  A senha **não** é escrita em nenhum comando: ela é lida sem eco por `read -rs`.
- **URLs entre aspas.** Toda URL vai entre aspas duplas (`"…"`), para o shell não interpretar `&`, `?`,
  `#` ou espaços.
- **Caracteres especiais nas credenciais.** Dentro de uma URL, a senha precisa estar **codificada**
  (`@` → `%40`, `:` → `%3A`, `/` → `%2F`, `#` → `%23`, `%` → `%25`, `?` → `%3F`, espaço → `%20`). Os
  blocos fazem isso automaticamente a partir da senha lida (`urllib.parse.quote(…, safe="")`). Já
  `createdb`, `dropdb` e `psql` recebem a senha **sem** codificação, pela variável `PGPASSWORD`. Se o
  nome de usuário tiver caracteres especiais, codifique-o da mesma forma na URL.
- **Recursos desta demonstração.** Tudo o que a demonstração cria tem nome próprio e é o único que a
  limpeza remove: o banco `prazoai_demo_recuperacao`, as mensagens enviadas a endereços
  `@demo-recuperacao.exemplo.com`, a pasta de build `frontend/.next-demo-recuperacao` e, só se você o
  iniciou aqui, o capturador. Nada preexistente é apagado.

### 9.1 Demonstração (Linux, recursos descartáveis)
Pré-requisitos: dependências instaladas conforme `backend/README.md` (ambiente em `backend/.venv`) e
`frontend/README.md` (`npm ci` em `frontend`).

**Passo 0 — conferir o que já existe** (qualquer terminal):
```bash
cd "<raiz>"
curl -s -o /dev/null -w "capturador em 8025: %{http_code}\n" "http://127.0.0.1:8025/readyz"   # 000 = livre
curl -s -o /dev/null -w "backend em 8000: %{http_code}\n" "http://127.0.0.1:8000/api/v1/health"
curl -s -o /dev/null -w "frontend em 3000: %{http_code}\n" "http://localhost:3000/login"
test -e frontend/.next-demo-recuperacao && echo "ATENÇÃO: frontend/.next-demo-recuperacao já existe" || echo "pasta de build livre"
test -f frontend/.env.local && echo "frontend/.env.local existe (não será alterado)" || echo "sem frontend/.env.local"
```
- Se o capturador já responde 200, **reutilize-o** (pule o Terminal 1 e, no fim, não o encerre).
- Se 8000 ou 3000 já estão ocupados, encerre o que **você** iniciou ali ou use outra máquina; não
  encerre processos de terceiros.
- Se `frontend/.next-demo-recuperacao` já existe, não é desta demonstração: não a apague; escolha outro
  nome e troque-o nos blocos do Terminal 3 e da limpeza.

**Terminal 1 — capturador** (só se o Passo 0 mostrou `000`). Escolha **uma** alternativa:
```bash
# Alternativa D — Docker (portas publicadas só em 127.0.0.1)
cd "<raiz>"
docker ps -a --filter name=prazoai-test-mailpit --format '{{.Names}} {{.Status}}'   # vazio = não existe
docker compose -f backend/test-infra/mailpit/compose.yaml up -d
curl -s -o /dev/null -w "%{http_code}\n" "http://127.0.0.1:8025/readyz"               # 200
```
Se o `docker ps` listar o contêiner `prazoai-test-mailpit`, ele já existia (por exemplo, de testes):
use-o e **não** rode `up`/`down` nesta demonstração.
```bash
# Alternativa B — binário oficial da MESMA versão (v1.31.6, linux-amd64; o CI confere o SHA-256 em
# .github/workflows/ci.yml). Fica em primeiro plano; Ctrl+C encerra só este processo.
cd "<raiz>"
"<caminho-do-mailpit>/mailpit" --listen 127.0.0.1:8025 --smtp 127.0.0.1:1025 --disable-version-check
```

**Terminal 2 — backend.** Escolha **uma** alternativa e execute o bloco inteiro neste terminal.

*Alternativa A — `STORAGE=memory` (sem banco; tudo se perde ao encerrar):*
```bash
cd "<raiz>/backend"
export ENVIRONMENT=development STORAGE=memory
export EMAIL_TRANSPORT=smtp PUBLIC_APP_ORIGIN="http://localhost:3000"
export EMAIL_FROM="PrazoAI <nao-responda@exemplo.com>"
export SMTP_HOST=127.0.0.1 SMTP_PORT=1025 SMTP_SECURITY=none SMTP_ALLOW_INSECURE_LOCAL=true
.venv/bin/uvicorn app.main:app --port 8000 --no-proxy-headers
```

*Alternativa B — `STORAGE=postgres` (banco criado só para a demonstração):*
```bash
cd "<raiz>/backend"
export PGHOST=localhost PGPORT=5432 PGUSER="<usuário-pg>"
read -rsp "Senha do PostgreSQL: " PGPASSWORD; echo; export PGPASSWORD
SENHA_URL="$(python3 -c 'import os, urllib.parse; print(urllib.parse.quote(os.environ["PGPASSWORD"], safe=""))')"
# cria o banco; se ele já existir, o comando FALHA: pare e escolha outro nome (nunca reutilize um banco existente)
createdb prazoai_demo_recuperacao
export DATABASE_URL="postgresql+psycopg://${PGUSER}:${SENHA_URL}@${PGHOST}:${PGPORT}/prazoai_demo_recuperacao"
.venv/bin/alembic upgrade head
.venv/bin/python -m app.db check     # destino sem credenciais e "revisão do esquema: 0003"
export ENVIRONMENT=development STORAGE=postgres
export EMAIL_TRANSPORT=smtp PUBLIC_APP_ORIGIN="http://localhost:3000"
export EMAIL_FROM="PrazoAI <nao-responda@exemplo.com>"
export SMTP_HOST=127.0.0.1 SMTP_PORT=1025 SMTP_SECURITY=none SMTP_ALLOW_INSECURE_LOCAL=true
.venv/bin/uvicorn app.main:app --port 8000 --no-proxy-headers
```
O log deve mostrar `password_recovery available_on_start=true` e `dispatcher_started …`.

**Terminal 3 — frontend integrado.** Nada é copiado para `.env.local`: as variáveis do BFF são
definidas aqui. Variáveis já definidas no ambiente prevalecem sobre os arquivos `.env*` do Next, então
um `frontend/.env.local` preexistente não é alterado nem interfere nas variáveis abaixo (as vazias
também contam como definidas). O build vai para uma pasta própria, para não sobrescrever `.next`.
```bash
cd "<raiz>/frontend"
export NEXT_PUBLIC_PRAZOAI_MODE=integrated PRAZOAI_APP_ENV=development
export PRAZOAI_APP_ORIGIN="http://localhost:3000" PRAZOAI_COOKIE_INSECURE_LOCAL=true
export PRAZOAI_BACKEND_URL="http://127.0.0.1:8000"
export PRAZOAI_PROXY_SECRET= PRAZOAI_TRUSTED_CLIENT_IP_HEADER=
export PRAZOAI_BFF_TIMEOUT_MS=10000 PRAZOAI_BFF_MAX_BODY_BYTES=65536
export PRAZOAI_BFF_MAX_SESSIONS=1000 PRAZOAI_BFF_SESSION_IDLE_SECONDS=28800
export PRAZOAI_BFF_SESSION_MAX_AGE_SECONDS=604800 PRAZOAI_BFF_SWEEP_INTERVAL_SECONDS=60
export PRAZOAI_ACCESS_REFRESH_SKEW_SECONDS=30
export PRAZOAI_DIST_DIR=.next-demo-recuperacao NEXT_TELEMETRY_DISABLED=1
npm run build && npm start
```
O `next build` reescreve `frontend/next-env.d.ts` e a lista `include` de `frontend/tsconfig.json`
para apontar a pasta de build (ver a limpeza). `.env.local` nunca é tocado.

**Verificação sem segredos** (um quarto terminal):
```bash
cd "<raiz>"
curl -s "http://127.0.0.1:8000/api/v1/auth/password-recovery/status"; echo                 # {"available":true}
curl -s -H "x-prazoai-csrf: 1" "http://localhost:3000/bff/public/password/status"; echo   # {"available":true}
```

**Roteiro.** Use só endereços `@demo-recuperacao.exemplo.com` (ex.: `ana@demo-recuperacao.exemplo.com`):
crie a conta em `/cadastro`, saia, abra `/login` → "Esqueci minha senha", peça o link, abra a
interface local do capturador em `http://127.0.0.1:8025` **neste computador**, clique no link, defina
a nova senha e entre com ela. A senha antiga deixa de funcionar e sessões abertas antes são encerradas
no próximo uso.

Para ver o modo **desabilitado**, encerre o backend (Ctrl+C) e, num terminal novo, suba-o sem as
variáveis de e-mail (o padrão é `EMAIL_TRANSPORT=disabled`): `status` responde `false` e o pedido, 503.
```bash
cd "<raiz>/backend"
export ENVIRONMENT=development STORAGE=memory
.venv/bin/uvicorn app.main:app --port 8000 --no-proxy-headers
```

**Encerramento e limpeza** — só o que esta demonstração criou:
```bash
# 1. Terminais 2 e 3: Ctrl+C. No backend, o log deve mostrar "dispatcher_stopped_clean".
# 2. Mensagens da demonstração (contém links com token): confira e apague SÓ as do domínio demonstrativo
cd "<raiz>"
curl -s "http://127.0.0.1:8025/api/v1/search?query=to:demo-recuperacao.exemplo.com" \
  | python3 -c 'import sys, json; print("mensagens da demonstração:", json.load(sys.stdin)["messages_count"])'
curl -s -X DELETE "http://127.0.0.1:8025/api/v1/search?query=to:demo-recuperacao.exemplo.com"; echo
# 3. Capturador — SÓ se você o iniciou no Terminal 1:
#    alternativa D: docker compose -f backend/test-infra/mailpit/compose.yaml down
#    alternativa B: Ctrl+C no Terminal 1
# 4. Build da demonstração e arquivos que o `next build` reescreve
cd "<raiz>/frontend"
rm -rf .next-demo-recuperacao
git status --short -- next-env.d.ts tsconfig.json
git diff -- next-env.d.ts tsconfig.json
# Se as ÚNICAS mudanças forem as do build (referências a .next-demo-recuperacao e a ordem do "include"
# no tsconfig.json), restaure-os. Não rode se você tinha mudanças próprias nesses arquivos:
# git restore next-env.d.ts tsconfig.json
```
```bash
# 5. Banco — SÓ na Alternativa B. Terminal novo: redefina as variáveis do PostgreSQL.
cd "<raiz>"
export PGHOST=localhost PGPORT=5432 PGUSER="<usuário-pg>"
read -rsp "Senha do PostgreSQL: " PGPASSWORD; echo; export PGPASSWORD
psql -d postgres -Atc "SELECT datname FROM pg_database WHERE datname = 'prazoai_demo_recuperacao'"   # deve listar só ele
dropdb prazoai_demo_recuperacao
unset PGPASSWORD
```

### 9.2 Comandos de teste (separados da demonstração)
Os testes apagam dados: usam **bancos descartáveis criados para eles**, nunca o da demonstração nem um
banco com dados. O backend só aceita bancos de teste chamados `prazoai_test` ou
`prazoai_test_<sufixo>`; o E2E não verifica o nome, então o bloco cria um banco novo para ele. O
capturador precisa estar ativo (como no Terminal 1 de §9.1).

```bash
# Terminal de testes (novo)
cd "<raiz>"
export PGHOST=localhost PGPORT=5432 PGUSER="<usuário-pg>"
read -rsp "Senha do PostgreSQL: " PGPASSWORD; echo; export PGPASSWORD
SENHA_URL="$(python3 -c 'import os, urllib.parse; print(urllib.parse.quote(os.environ["PGPASSWORD"], safe=""))')"
BASE_PG="postgresql+psycopg://${PGUSER}:${SENHA_URL}@${PGHOST}:${PGPORT}"
# cada createdb FALHA se o banco já existir: pare e escolha outro sufixo
createdb prazoai_test_recuperacao
createdb prazoai_e2e_recuperacao

# backend — transporte e fluxo real contra o capturador
cd "<raiz>/backend"
ENVIRONMENT=test TEST_DATABASE_URL="${BASE_PG}/prazoai_test_recuperacao" \
  PRAZOAI_TEST_MAILPIT_SMTP=127.0.0.1:1025 PRAZOAI_TEST_MAILPIT_API="http://127.0.0.1:8025" \
  .venv/bin/pytest tests/test_recovery_mailpit.py tests/test_smtp_child_env.py

# frontend — unitários, integração BFF × FastAPI (memória) e E2E (PostgreSQL)
cd "<raiz>/frontend"
npm test
PRAZOAI_TEST_PYTHON="<raiz>/backend/.venv/bin/python" PRAZOAI_TEST_MAILPIT_SMTP=127.0.0.1:1025 \
  PRAZOAI_TEST_MAILPIT_API="http://127.0.0.1:8025" npm run test:integration
(cd "<raiz>/backend" && DATABASE_URL="${BASE_PG}/prazoai_e2e_recuperacao" .venv/bin/alembic upgrade head)
PRAZOAI_TEST_PYTHON="<raiz>/backend/.venv/bin/python" STORAGE=postgres \
  DATABASE_URL="${BASE_PG}/prazoai_e2e_recuperacao" \
  PRAZOAI_TEST_MAILPIT_SMTP=127.0.0.1:1025 PRAZOAI_TEST_MAILPIT_API="http://127.0.0.1:8025" npm run test:e2e

# limpeza: só os bancos criados acima
cd "<raiz>"
psql -d postgres -Atc "SELECT datname FROM pg_database WHERE datname IN ('prazoai_test_recuperacao', 'prazoai_e2e_recuperacao')"
dropdb prazoai_test_recuperacao
dropdb prazoai_e2e_recuperacao
unset PGPASSWORD SENHA_URL BASE_PG
```
Sem as variáveis do capturador, os testes que dependem de e-mail são **pulados**; com
`PRAZOAI_REQUIRE_MAILPIT_TESTS=1` (como no CI) eles **falham**. **Atenção:** os testes de e-mail
apagam **todas** as mensagens do capturador, antes e depois de rodar. Não os execute contra um
capturador que guarde mensagens que você queira manter (por exemplo, durante a demonstração): termine
e limpe a demonstração antes, ou use um capturador separado só para os testes. O E2E faz um build
próprio (`frontend/.next-e2e`, ignorado pelo git) e também pode reescrever `next-env.d.ts` e
`tsconfig.json`; confira-os com `git diff` como no passo 4 da limpeza de §9.1.

### 9.3 Segurança do capturador
- Portas só em `127.0.0.1`; nunca publique a interface, nem por túnel ou proxy.
- A interface e a API mostram os e-mails completos, **com os links que permitem trocar senhas**.
- Use contas fictícias, apague as mensagens da demonstração ao terminar (§9.1) e, se o capturador foi
  iniciado só para isso, encerre-o. Não configure relay
  (`MP_SMTP_RELAY_*`/`--smtp-relay-*`): o compose do projeto não define nenhum.

## 10. Observabilidade existente (revisão do código)

Não há endpoint de métricas nem painel. Hoje há três fontes: **logs** (texto, `LOG_LEVEL`),
**respostas HTTP** e **contadores em memória** do despachante, que **não são expostos** por nenhuma rota
(só por `RecoveryDispatcher.snapshot()` dentro do processo, usado pelos testes).

### 10.1 Logs do backend
| Evento | Nível | Onde | Campos | Quando |
|---|---|---|---|---|
| `password_recovery available_on_start=` | INFO | `app/main.py` | `true`/`false` | na inicialização |
| `dispatcher_started` | INFO | `recovery/dispatcher.py` | `queue_max`, `max_wait_s`, `cancel_with_timeout` | início do worker |
| `recovery_item request_id=… result=…` | INFO | `recovery/dispatcher.py` | id aleatório do pedido, categoria (§10.3) | fim de cada pedido retirado da fila |
| `recovery_stage_failed category=… error=…` | WARNING | `recovery/processor.py` | categoria, **classe** da exceção | falha de banco ou entrega |
| `recovery_item_failed error=…` | WARNING | `recovery/dispatcher.py` | classe | exceção inesperada num pedido (o worker segue) |
| `recovery_issued_not_sent user_id=…` | INFO | `recovery/processor.py` | id do usuário | parada reconhecida depois da emissão |
| `recovery_worker_died error=… discarded=N` | ERROR | `recovery/dispatcher.py` | classe, pendências descartadas | morte do worker |
| `dispatcher_shutdown_discarded count=N` | INFO | `recovery/dispatcher.py` | contagem | pendências descartadas no encerramento |
| `dispatcher_stopped_clean` | INFO | `recovery/dispatcher.py` | — | encerramento limpo |
| `dispatcher_stop_unclean stage=… worker_alive=… connection=… child=…` | ERROR | `recovery/dispatcher.py` | etapa, estados | encerramento não limpo |
| `recovery_db_cancel_failed` | WARNING | `recovery/cancel.py` | — | cancelamento no banco falhou |
| `email_send result=… duration_ms=…` (`reap_failed=true`) | INFO | `email/smtp_subprocess.py` | categoria do transporte (§10.3), duração | cada tentativa |
| `email_smtp_reap_failed` | ERROR | `email/smtp_subprocess.py` | — | filho sem coleta confirmada |
| `email_smtp_cancel_unconfirmed reason=lock_timeout` | ERROR | `email/smtp_subprocess.py` | — | cancelamento sem confirmação no prazo |
| `app_error method=… path=… status=… code=…` | INFO | `core/errors.py` | rota, status, código | 503, 429, 400 `invalid_reset_token` etc. |
| `auth_password_reset user_id=… sessions_revoked=true` | INFO | `services/auth_service.py` | id do usuário | redefinição concluída |
| `maintenance operation=… total=…` | INFO | `maintenance/purge.py` | contagens por categoria | expurgo |

Os logs **não** contêm e-mail, token, senha, link, corpo da mensagem nem credenciais SMTP
[LIDO; EXECUTADO na demonstração: zero ocorrências]. Contêm `user_id` e a categoria `unknown_user`,
que revela a um leitor dos logs que um pedido foi para conta inexistente (sem dizer qual e-mail):
**logs são dados restritos**.

### 10.2 BFF e telas
- BFF: `bff_public_password_uncertain` (`console.info`, com `route` e `reason`) quando uma chamada
  pública fica sem confirmação. Erros de configuração aparecem como `bff_config_error`.
- Telas: nenhuma telemetria. Os estados "pedido não confirmado", "resultado não confirmado" e "novo
  link recebido" existem só na interface de quem os vê.

### 10.3 Categorias e contadores
Contadores do despachante (em memória, por processo): `enqueued`, `queue_full`,
`rejected_unavailable`, `shutdown_discarded`, `worker_died_discarded` e um contador por categoria de
resultado:

| Categoria (`recovery_item result=`) | Significado |
|---|---|
| `queue_expired` | esperou demais na fila; descartado antes do banco |
| `stopped` / `stopped_after_issue` | parada reconhecida antes da etapa / depois da emissão (token não enviado) |
| `unknown_user` | conta inexistente; nada emitido |
| `lookup_failed` / `issue_failed` / `issue_conflict` | falha de banco na busca / na emissão / conflito concorrente |
| `delivery_failed` | exceção ao montar ou entregar |
| `delivery_<resultado>` | resultado do transporte, abaixo |
| `item_failed` | exceção inesperada no pedido |

| Resultado do transporte (`email_send result=`) | Significado |
|---|---|
| `accepted` | aceito pelo servidor SMTP (≠ entregue na caixa) |
| `refused` | remetente, destinatário ou dados recusados |
| `auth_error` | autenticação SMTP recusada |
| `tls_error` | TLS, certificado, nome ou STARTTLS ausente (sem rebaixamento) |
| `timeout` | timeout de uma operação no filho (conexão ou leitura) |
| `error` | qualquer outra falha no filho, **inclusive conexão recusada e DNS** |
| `deadline_killed` | prazo total vencido; filho encerrado; entrega **incerta** |
| `invalid_output` | o filho terminou sem uma categoria conhecida (inclusive quando nem chegou a rodar) |
| `spawn_failed` | não foi possível criar o filho |
| `cancelled` | parada pedida; incerta se o filho já tinha começado |
| `unavailable` | transporte indisponível (ex.: depois de falha de coleta) |

### 10.4 O que `{ available: true }` significa
`true` quer dizer só que o **mecanismo interno** aceita pedidos agora: transporte `smtp` configurado,
despachante em execução e não parando, thread do worker viva e transporte sem falha de coleta. **Não**
testa o servidor SMTP, a rede, o TLS nem as credenciais, e não diz nada sobre a chegada à caixa.
[EXECUTADO] Com o backend apontando para uma porta SMTP sem servidor, `status` respondeu `true` antes
e depois de um pedido cujo envio terminou em `email_send result=error`.

## 11. Diagnóstico: sintoma → evidência → causa → ação

| Sintoma | Evidência sanitizada | Possíveis causas | Ação segura | Limitação |
|---|---|---|---|---|
| Tela "Recuperação indisponível"; pedido 503 | `status` → `false`; `app_error … status=503 code=password_recovery_unavailable`; na inicialização `available_on_start=false` | `EMAIL_TRANSPORT=disabled` (padrão); depois de iniciado: worker morto, despachante parando/parado, transporte indisponível após falha de coleta | conferir a configuração (abaixo, §12.1); se começou `true`, procurar `recovery_worker_died`, `email_smtp_reap_failed`, `dispatcher_stop*`; reiniciar o processo depois de entender a causa | `status` não informa o motivo; `/api/v1/health` não inclui a recuperação |
| Configuração `smtp` inválida | a aplicação **não inicia** (erro de validação sem a senha) | origem, remetente, segurança, credenciais ou plataforma | corrigir a variável indicada | — |
| 429 "Muitas solicitações" / "Muitas tentativas" | `app_error … status=429 code=rate_limited` com a rota; `Retry-After` na resposta | limite por IP (compartilhado se o BFF não repassa o IP do cliente), por e-mail (pedido) ou por IP (redefinição) | esperar o `Retry-After`; não aumentar limites para "resolver" | o log não diz **qual** limite; limites em memória, zerados no reinício e por processo |
| Pedido aceito, e-mail não chega; nada no log do pedido | só o 202 no acesso; contador `queue_full` | fila cheia | pedir de novo mais tarde; investigar lentidão do envio (`duration_ms`) | **fila cheia não gera log** e o contador não é exposto |
| Pedido aceito, e-mail não chega | `recovery_item … result=queue_expired` | worker lento (envios perto do prazo) ou rajada | conferir `email_send … duration_ms`; pedir de novo | descarte proposital; sem aviso à pessoa (resposta neutra) |
| E-mail não sai; filho não inicia | `email_send result=spawn_failed` ou `result=invalid_output` | interpretador não inicia com o ambiente mínimo (ex.: `libpython` relocada — corrigida), limites do sistema, Python ausente | testar o interpretador como o transporte o executa: `env -i PATH=/usr/bin:/bin LANG=C.UTF-8 LC_ALL=C.UTF-8 <python> -I -c pass; echo $?` (sem segredos; se precisar, acrescente só o diretório da `libpython`) | `invalid_output` é o mesmo para "não iniciou", "travou" e "saída inesperada"; a saída de erro do filho é descartada |
| E-mail não sai; falha de SMTP | `email_send result=error` / `tls_error` / `auth_error` / `refused` / `timeout` | host ou porta errados, servidor fora, DNS, certificado ou nome, STARTTLS ausente, credencial, remetente recusado | conferir host, porta e `SMTP_SECURITY` sem imprimir a senha; para CA privada, `SMTP_CA_FILE`; **nunca** rebaixar para `none` fora do loopback | `error` junta conexão recusada, DNS e falhas inesperadas; `timeout` junta conexão e leitura; códigos SMTP não são registrados |
| Envio demorado demais | `email_send result=deadline_killed` | servidor lento ou rede | a pessoa confere a caixa antes de pedir outro | entrega **incerta**: a mensagem pode ter sido aceita |
| Tela "Pedido não confirmado" ou "Resultado não confirmado" | BFF: `bff_public_password_uncertain route=… reason=…`; resposta 504 `outcome: "unknown"` | timeout ou rede entre navegador, BFF e backend | pedido: conferir a caixa antes de pedir de novo (um novo pedido invalida o link anterior); redefinição: tentar entrar com a **nova** senha antes de qualquer outra ação | não há identificador que ligue o log do BFF ao do backend |
| Recuperação fica indisponível depois de um envio | `email_smtp_reap_failed`; `email_send … result=unavailable reap_failed=true`; `status` → `false` | filho que não terminou nem com `SIGKILL` no prazo de coleta | investigar processos filhos remanescentes e reiniciar o processo do backend | indisponível até o reinício, de propósito (nunca dois filhos) |
| Recuperação fica indisponível sem envio | `recovery_worker_died error=<classe> discarded=N` | defeito no worker | registrar a classe do erro, reiniciar e tratar como defeito | sem thread substituta; pedidos pendentes perdidos |
| Encerramento demorado ou processo que não termina | `dispatcher_stop_unclean stage=… worker_alive=… connection=… child=…` | worker preso em banco ou SMTP além do orçamento | deixar o orquestrador terminar o processo (`SIGTERM`, depois `SIGKILL`); conferir se não ficou filho SMTP | o encerramento da aplicação não garante o término do processo (§12.4) |
| Encerramento normal | `dispatcher_stopped_clean` (antes, talvez `dispatcher_shutdown_discarded count=N`) | — | nenhuma | pedidos na fila foram descartados |
| "Link inválido" | `app_error … status=400 code=invalid_reset_token` em `/api/v1/auth/reset-password` | token inválido, usado, expirado ou substituído por pedido mais novo | pedir um novo link | **indistinguível de propósito**, também nos logs (não há oráculo) |
| Tela "Novo link recebido" | nenhuma no servidor (estado da tela); dois `POST /api/v1/auth/reset-password` no acesso | a pessoa abriu outro link na mesma aba durante uma redefinição | esperar a tentativa anterior terminar; para saber se ela valeu, entrar com a senha usada nela | o resultado da tentativa anterior não é mostrado; sem telemetria |

## 12. Procedimentos seguros

### 12.1 Conferir saúde e configuração sem imprimir segredos
- `GET /api/v1/auth/password-recovery/status` e `GET /bff/public/password/status` (com
  `x-prazoai-csrf: 1`): só o booleano.
- Log de inicialização: `password_recovery available_on_start=…` e `dispatcher_started …`.
- Banco: `python -m app.db check` mostra destino **sem credenciais**, versão e revisão do esquema.
- Para conferir quais variáveis estão definidas, liste **só os nomes**
  (ex.: `env | grep -E '^(EMAIL|SMTP|RECOVERY|PUBLIC_APP)_' | cut -d= -f1`), nunca os valores.

### 12.2 Desabilitar o transporte
Defina `EMAIL_TRANSPORT=disabled` (ou remova a variável) e reinicie o backend. Efeito: `status` →
`false`, pedidos → 503, telas mostram indisponível. Tokens já emitidos continuam válidos até expirar ou
serem usados. Não há desligamento sem reinício.

### 12.3 Reinício: fila volátil
A fila e os limites vivem na memória do processo. Num encerramento normal, os pedidos na fila são
descartados e contados (`dispatcher_shutdown_discarded`); numa queda, perdidos sem registro. A
resposta neutra continua verdadeira; a pessoa pede de novo (sujeita ao limite por e-mail, que também
zera com o reinício). Um token emitido e não enviado expira sozinho e a manutenção o remove.

### 12.4 Parada limpa e não limpa
- **Limpa** (`dispatcher_stopped_clean`): worker terminou e, confirmados dentro do orçamento, não há
  conexão exclusiva aberta nem filho SMTP sem coleta.
- **Não limpa** (`dispatcher_stop_unclean`): algo não foi confirmado dentro de
  `RECOVERY_SHUTDOWN_GRACE_SECONDS`. A recuperação fica indisponível.
- O orçamento limita **o encerramento da aplicação**, não o término do processo: o worker não é
  daemon e pode manter o processo vivo. Terminar o processo é responsabilidade de quem o executa
  (orquestrador, `systemd`, terminal).

### 12.5 Sem repetição automática; por que não reenviar às cegas
Nenhuma camada repete pedido ou redefinição (backend, BFF e telas). Depois de um resultado
desconhecido, um reenvio cego pode: no **pedido**, emitir outro token e invalidar o link que talvez já
tenha chegado; na **redefinição**, receber "link inválido" porque a primeira tentativa já consumiu o
token — e a pessoa concluir, errado, que nada mudou. Por isso a orientação é sempre **conferir antes**:
caixa de entrada, ou entrar com a nova senha.

### 12.6 Investigar sem expor dados
- Use os logs por categoria e `request_id`; não aumente o nível de log para "ver mais": não há modo
  que imprima corpo, token ou destinatário.
- Não registre corpos HTTP, cabeçalhos de autenticação, cookies, o e-mail completo da pessoa, o link
  recebido nem o ambiente inteiro do processo. Se precisar citar uma conta, use o `user_id`.
- Não copie mensagens do capturador para tickets ou relatórios; descreva o resultado ("mensagem
  presente/ausente").
- Não altere dados diretamente no banco nem rode `downgrade` para investigar.

### 12.7 Retenção e manutenção dos tokens
- Um token ativo por conta: um pedido novo invalida o anterior. Validade:
  `AUTH_PASSWORD_RESET_TTL_SECONDS` (30 min por padrão). Só o hash fica guardado.
- PostgreSQL: tokens **usados, invalidados ou expirados** são removidos pela manutenção da P5 —
  oportunista (no máximo uma vez por intervalo e por processo, depois de uma resposta) ou pelo comando
  `python -m app.maintenance purge` (códigos de saída em `docs/backend/20-p5-manutencao-operacao.md`).
- Memória: removidos pelo próprio processo, no máximo uma vez a cada 60 s, quando há emissão de token
  ou criação de sessão; tudo se perde no reinício. O comando de manutenção não atua sobre a memória
  (sai com código 3).

### 12.8 Formato antigo da URL nos logs de acesso
Links `/redefinir-senha/<token>` nunca foram emitidos, mas, se alguém acessar esse formato, a
aplicação só mostra uma página estática. O servidor HTTP, proxy, CDN ou hospedagem **podem registrar
o caminho com o token** nos logs de acesso. A aplicação não controla esses logs; mascarar
`/redefinir-senha/*` neles é configuração da infraestrutura (§15).

### 12.9 Limites do fragmento
O token não vai ao servidor nem ao `Referer`, é apagado da barra e não fica em storage. Mesmo assim:
- o **histórico** do navegador pode guardar a URL aberta com o fragmento;
- a entrada de *Navigation Timing* (`performance.getEntriesByType("navigation")`) mantém a URL inicial
  durante a vida da página, visível a scripts da mesma origem (a aplicação não tem analytics).
Não há API para apagar esses registros; a proteção vem do token: uso único, expiração e substituição.

## 13. Lacunas de observabilidade (pendências, não implementadas)
1. Contadores do despachante sem exposição (rota, métrica ou log periódico).
2. `queue_full` só contado, sem log.
3. `error` e `invalid_output` juntam causas diferentes (conexão recusada × DNS; filho que não iniciou
   × saída inesperada); a saída de erro do filho é descartada.
4. Nenhum identificador de correlação entre o 202 do pedido, o `request_id` do worker e o log do BFF.
5. `status` e `health` não informam o motivo da indisponibilidade nem o estado do despachante.
6. O log de limite não diz qual limitador (IP ou e-mail) recusou.
7. Nenhum sinal de chegada à caixa (rejeição posterior, devolução, filtro de spam).
8. Nenhuma telemetria dos estados "não confirmado" e "novo link recebido" nas telas.
Qualquer mudança aqui é código e precisa de entrega própria, sem expor e-mail, token ou senha.

## 14. Glossário
- **BFF:** servidor do próprio frontend que fala com a API em nome do navegador.
- **Capturador SMTP (Mailpit):** servidor local que recebe e guarda e-mails sem repassá-los.
- **Despachante e worker:** fila em memória e a única thread que processa os pedidos.
- **Fragmento:** parte da URL depois de `#`; não vai ao servidor.
- **Resposta neutra:** a mesma resposta para conta existente ou não (evita enumeração).
- **Resultado desconhecido:** o pedido pode ter sido processado, mas a confirmação não chegou.
- **Aceito pelo SMTP:** o servidor de envio aceitou a mensagem; não é o mesmo que chegar à caixa.
- **Coleta do filho:** confirmar que o subprocesso terminou e foi liberado pelo sistema.
- **Parada limpa:** encerramento em que tudo foi confirmado dentro do prazo.

## 15. Prontidão futura (não implantada)
**Produção está bloqueada por código:** o backend recusa iniciar com `ENVIRONMENT=production`
(`ProductionNotReleasedError`), em qualquer configuração; `STORAGE=postgres` também só aceita
`development`/`test`. SMTP local não prova entrega por provedor externo. Pendências de uma entrega
própria de prontidão:
- escolha e configuração do provedor de e-mail (com TLS e credenciais próprias);
- domínio e remetente, com as verificações exigidas pelo provedor (por exemplo SPF, DKIM e DMARC);
- gestão de segredos (credenciais SMTP, `AUTH_JWT_SECRET`, segredos do proxy);
- HTTPS e infraestrutura confiável para o IP do cliente (cabeçalho sobrescrito, segredo compartilhado);
- backups e restauração **testada** do PostgreSQL;
- monitoramento e procedimentos de incidentes (inclui as lacunas de §13 e o mascaramento de §12.8);
- sessões do BFF, fila e limites hoje **por processo e em memória**;
- decisão sobre múltiplas instâncias e eventual armazenamento compartilhado (fila durável, limites e
  sessões compartilhados);
- atualização de dependências e demais pendências de segurança.

**Pendências separadas, sem alteração nesta entrega:** fuso das notificações (doc 21, §16.4),
deslocamento de layout no convite (doc 21, §17.2) e atualização de dependências.

## 16. Roteiro para o TCC (cerca de 5 minutos)
1. **Problema (40 s):** esquecer a senha é comum; a recuperação precisa funcionar sem revelar quem tem
   conta e sem deixar o link vazar.
2. **Pedido (1 min):** na tela, a pessoa informa o e-mail. O servidor só confere limites e enfileira;
   a resposta é sempre a mesma. Mostrar `/esqueci-senha` e a mensagem neutra.
3. **Envio (1 min):** um worker emite o token (só o hash vai ao banco) e envia por SMTP num processo
   separado, com prazo. Mostrar o e-mail no capturador local e explicar: aceito pelo SMTP não é o
   mesmo que entregue.
4. **Link seguro (1 min):** o token vem depois do `#`, que não vai ao servidor; a página o apaga da
   barra e o guarda só em memória. Abrir o link e mostrar a barra limpa.
5. **Troca e efeitos (1 min):** definir a nova senha; a antiga é recusada, a nova funciona e uma sessão
   aberta antes cai no próximo uso.
6. **Limites honestos (20 s):** sem repetição automática; resultado desconhecido orienta conferir; a
   fila é em memória; produção continua bloqueada até a entrega de prontidão.

## 17. Arquivos e documentos relacionados
`backend/README.md`, `frontend/README.md`, `backend/.env.example`, `frontend/.env.example`,
`backend/test-infra/mailpit/compose.yaml`, [doc 20](20-p5-manutencao-operacao.md) (manutenção),
[doc 13](13-ambiente-e2e-identidade-de-rede.md) (identidade de rede no E2E) e
[doc 21](21-projeto-email-recuperacao.md) (projeto e histórico).

## 18. Conferência desta entrega
> §18 e §18.1 registram a **primeira** conferência (commit `a7fb7a7`), feita com o roteiro anterior
> (banco `prazoai_demo`, cópia para `.env.local`). A revisão de §9 foi revalidada em shells novos:
> ver §18.2.

**[EXECUTADO]** em recursos locais descartáveis (Linux, Python 3.12, PostgreSQL 16 local, Mailpit
v1.31.6 pelo binário oficial em 127.0.0.1:1025/8025, Node 22; Docker **indisponível** neste ambiente,
então o caminho `docker compose` foi conferido só por leitura):
- capturador iniciado e `readyz` = 200;
- banco `prazoai_demo` criado, `app.db check` antes e depois de `alembic upgrade head` (revisão `0003`),
  depois removido;
- backend em `development` + `postgres` + `smtp` com as variáveis de §9.1 (a primeira tentativa falhou
  porque `EMAIL_FROM` sem aspas quebra no shell — daí a observação em §7.1);
- `status` direto e pelo BFF; cadastro, pedido para conta existente e inexistente (os dois 202 com a
  mesma mensagem); mensagem no capturador; logs `email_send result=accepted`,
  `recovery_item … result=delivery_accepted` e `result=unknown_user`;
- pelo navegador (Playwright, só o roteiro): link aberto, barra sem fragmento, nova senha definida;
  login com a senha antiga → 401, com a nova → 200; uma sessão aberta antes da redefinição → 401
  `session_expired` no uso seguinte;
- `Ctrl+C` (SIGINT) no backend → `dispatcher_stopped_clean`; logs sem e-mail, link, token ou senha;
- modo desabilitado: `status` `false`, pedido 503, `available_on_start=false`;
- SMTP sem servidor: `status` `true`, envio `result=error`, `status` ainda `true` (§10.4);
- frontend: `cp .env.example .env.local`, `npm run build`, `npm start`;
- encerramento: mensagens apagadas, capturador parado, banco removido, `.env.local` apagado;
- comandos de teste de §9.2 citados em §18.1.

**[LIDO]** (conferido contra o código, não executado aqui): plataforma não Linux, configuração
inválida impedindo a inicialização, falha de coleta, morte do worker, parada não limpa, fila cheia,
`deadline_killed`, `tls_error`, `auth_error`, os caminhos de `docker compose` e `dropdb`/`createdb`
(executados aqui pelo equivalente em SQL), a página do link antigo e os estados das telas (cobertos
pelos E2E do CI da base).

### 18.1 Comandos de teste de §9.2
- **[EXECUTADO]** `pytest tests/test_recovery_mailpit.py tests/test_smtp_child_env.py` com
  `TEST_DATABASE_URL` em `prazoai_test` descartável e o capturador em 127.0.0.1:1025/8025: 18 aprovados.
- **[EXECUTADO]** `npm test`: 299 aprovados. `npm run test:integration` (memória, capturador
  obrigatório): 45 aprovados; capturador vazio ao final.
- **[EXECUTADO]** `python -m app.maintenance purge` num banco descartável migrado: `status: ok`, código 0;
  com `STORAGE=memory`: código 3.
- **[LIDO]** `npm run test:e2e` não foi executado nesta entrega: o comando e as variáveis foram conferidos
  contra `frontend/playwright.config.ts`, `frontend/e2e/global-setup.mjs` e o passo do CI, que o executou
  com sucesso na base (execução `44194894812`).

### 18.2 Revalidação de §9 depois da revisão (shells novos)
Cada bloco de §9 foi **extraído deste documento** e executado num shell novo
(`env -i HOME=… PATH=… bash --noprofile --norc`), sem variáveis herdadas da sessão de trabalho e sem
perfil. As únicas mudanças no texto executado foram as substituições previstas em §9.0.

**Equivalentes usados neste ambiente** (não alteram o procedimento):
| No documento | Usado aqui | Motivo |
|---|---|---|
| `<raiz>` | `/home/claude/main` | caminho do clone |
| `PGHOST=localhost PGPORT=5432`, `<usuário-pg>` | `127.0.0.1`, `55441`, papel `demo_rec` criado só para a revalidação (e removido depois), com uma senha fictícia contendo `@`, `:`, `/`, `#`, `%` e espaço | PostgreSQL local descartável; a senha com `@ : / # %` e espaço exercita a codificação |
| senha digitada em `read -rsp` | a mesma senha entregue pela entrada padrão | sem terminal interativo |
| `backend/.venv` | link simbólico temporário para o ambiente Python 3.12 já instalado | o ambiente não estava em `backend/.venv` |
| Terminal 1, alternativa B (`<caminho-do-mailpit>`) | binário oficial v1.31.6 já extraído | Docker indisponível: a alternativa D foi só lida |
| Ctrl+C nos terminais | `SIGINT` enviado aos processos | execução em segundo plano |
| clicar no roteiro | Playwright seguindo as mesmas telas; o link lido do capturador pelo harness | automação do roteiro |
| `npm run test:e2e` | acrescido `PLAYWRIGHT_CHROMIUM_EXECUTABLE` para o Chromium local | a revisão do navegador esperada pelo Playwright não está instalada aqui |

Para comprovar que nada preexistente é tocado, a revalidação criou antes **sentinelas**: um
`frontend/.env.local` com valores conflitantes (`NEXT_PUBLIC_PRAZOAI_MODE=demo`, origem e backend
inválidos), uma mensagem no capturador para `sentinela@outro.exemplo.com` e o banco
`prazoai_preexistente_sentinela`. Ao final, foram removidos pela própria revalidação (não fazem parte
do procedimento).

**[EXECUTADO] Resultado:**
- Passo 0: as três portas livres; pasta de build livre; `.env.local` detectado.
- Terminal 2, alternativa B: `createdb`, `alembic upgrade head` (até `0003`) e `app.db check` com a URL
  codificada; backend com `available_on_start=true`; a senha não apareceu no log.
- Terminal 3: build e início com `.env.local` presente e conflitante — as variáveis do terminal
  prevaleceram (modo integrado, backend correto); o arquivo ficou idêntico (mesmo SHA-256).
- Verificação: `{"available":true}` no backend e no BFF.
- Roteiro (`ana@demo-recuperacao.exemplo.com`): barra sem fragmento após abrir o link; senha antiga
  recusada, nova aceita; sessão aberta antes encerrada no próximo uso.
- Encerramento: `dispatcher_stopped_clean`. Limpeza: 1 mensagem demonstrativa encontrada e apagada; a
  mensagem-sentinela **permaneceu**; a pasta `.next-demo-recuperacao` foi removida; o
  `.env.local`-sentinela ficou intacto; só `prazoai_demo_recuperacao` foi removido (demais bancos,
  inclusive o sentinela, permaneceram).
- Alternativa A (`memory`): `available_on_start=true`; modo desabilitado: `status` `false`.
- §9.2 inteiro, num shell novo, com a mesma senha especial: `pytest` 18 aprovados; `npm test` 299;
  `npm run test:integration` 45; `npm run test:e2e` 59 aprovados; os dois bancos de teste criados pelo
  bloco foram os únicos removidos; capturador vazio ao final; senha ausente da saída.

**Defeito do texto encontrado e corrigido na revalidação:** o `next build` da demonstração também
reescreve `frontend/tsconfig.json`; a primeira versão revisada da limpeza só conferia
`next-env.d.ts`. O passo 4 agora confere e restaura os dois (o passo 4 corrigido foi executado de
novo num shell novo). Nenhum defeito de produto foi encontrado.
