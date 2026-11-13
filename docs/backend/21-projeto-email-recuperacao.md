# 21 — Projeto técnico: e-mail transacional e recuperação de senha ponta a ponta

> **Tipo de entrega:** PROJETO. Nenhum código, dependência, migration ou infraestrutura foi
> adicionado. Nenhum provedor foi contratado, nenhuma credencial foi pedida e nenhum e-mail foi
> enviado.
>
> **Base:** `main` `08e60a4bccb69590d5d335fd6f1cba2bf023f8f7` (merge do PR #22, P5), sem commits
> posteriores. Árvore idêntica à P5 auditada (`d8f5d93`). CI pós-merge `43347299279` conferido
> verde (33/33 passos, incluindo integração nos dois modos e E2E em PostgreSQL). Esse CI valida a
> **base**, não este projeto. Branch: `docs/projeto-email-recuperacao`.
>
> **Status:** aguardando auditoria e aprovação das decisões (§4 e §12) antes de implementar.
>
> **Revisão 3** (commit incremental sobre `ccff5c2`):
> - D-E8: prazo total do SMTP por **subprocesso supervisionado** (§4.6);
> - D-E11: **protocolo de encerramento** em etapas, separando encerramento limpo de prazo rígido
>   (§4.7);
> - remoção das frases que prometiam tempo igual;
> - testes planejados e decisões atualizados.
>
> **Revisão 2** (commit incremental sobre `2e8509d`, auditoria do projeto). Itens:
> - contrato completo do `RecoveryDispatcher` (§4.5);
> - limites de tempo garantidos (§4.6);
> - garantias reescritas de forma verificável (§5);
> - outbox de intenção corrigida (§4.2);
> - matriz de testes ampliada (§9);
> - decisões D-E8 a D-E11.
>
> Desenho mantido: SMTP genérico, capturador local, origem configurada, 503 com recuperação
> desabilitada e nenhuma repetição automática de envio. A fila em memória continua como proposta
> **temporária**.

Convenção usada em todo o documento:
**[EXISTE]** está implementado na base;
**[LIMITAÇÃO]** é o comportamento atual que precisa mudar;
**[PROPOSTA]** é o que este projeto sugere (nada disso está pronto).

---

## 1. Mapa do que existe hoje

### 1.1 Backend (FastAPI)
| Componente | Arquivo | Comportamento atual |
|---|---|---|
| Mensagem | `app/services/password_reset_delivery.py` → `PasswordResetMessage(user_id, email, token, expires_at)` | **[EXISTE]** token em claro **só** em memória, para o canal; `__repr__` mostra apenas `user_id` |
| Contrato de entrega | idem → `PasswordResetDelivery.send(message)` (Protocol) | **[EXISTE]** síncrono, sem valor de retorno |
| Entrega padrão | idem → `NoopPasswordResetDelivery` | **[EXISTE]** registra `password_reset_requested delivery=noop` (sem e-mail, sem token). **[LIMITAÇÃO]** nenhum e-mail é enviado |
| Composição | `app/services/auth_container.py` (`delivery or NoopPasswordResetDelivery()`), `app/main.py` (`password_reset_delivery=` injetável) | **[EXISTE]** testes injetam `CapturingDelivery` |
| Pedido | `AuthService.forgot_password(email)` | **[EXISTE]** limite por e-mail → busca do usuário → (se existir) token `secrets.token_urlsafe(32)` → `issue_replacing_active` → `send` **depois do COMMIT** → exceção de entrega só gera log `password_reset_delivery_failed` |
| Emissão | `SqlPasswordResetRepository.issue_replacing_active` (P3) | **[EXISTE]** `users FOR NO KEY UPDATE` → relógio **pós-lock** → invalida o token ativo → insere o novo (só **SHA-256**) → devolve o registro **persistido**; a mensagem usa essa expiração |
| Redefinição | `AuthService.reset_password(token, new_password, client_ip)` | **[EXISTE]** limite por IP → pré-validação barata (sem Argon2) → Argon2 fora de transação → `complete_reset`: `users FOR UPDATE` → token `FOR UPDATE` → relógio pós-lock → consumo + nova senha + `credential_version + 1` + invalidação dos demais tokens + revogação de **todas** as sessões, numa transação |
| Unicidade | índice `uq_password_reset_tokens_one_active_per_user` | **[EXISTE]** no máximo um token não usado e não invalidado por usuário |
| Retenção | `app/maintenance` (P5), categoria `password_reset_tokens` | **[EXISTE]** remove usados, invalidados e expirados em lotes |
| Rotas | `POST /api/v1/auth/forgot-password` → 202 com mensagem genérica; `POST /api/v1/auth/reset-password` `{token, newPassword}` → 204 | **[EXISTE]** sem autenticação; o reset não faz login |
| Limites | `AUTH_FORGOT_MAX_REQUESTS=3` / `AUTH_FORGOT_WINDOW_SECONDS=900` **por e-mail**; `AUTH_RESET_MAX_REQUESTS=10` / 900 s **por IP**; `AUTH_RATE_LIMIT_MAX_KEYS=10000` (balde de transbordo) | **[EXISTE]** em memória, por processo. **[LIMITAÇÃO]** o pedido não tem limite por IP |
| TTL | `AUTH_PASSWORD_RESET_TTL_SECONDS=1800` (300–86400) | **[EXISTE]** |

**[LIMITAÇÃO] de tempo:** para um e-mail inexistente, o pedido retorna logo depois da busca; para
um existente, faz uma transação com bloqueio e chama `send` no próprio fluxo da requisição. A
diferença de latência pode revelar se a conta existe, e uma entrega síncrona real (SMTP) a
aumentaria muito.

**[LIMITAÇÃO]:** o backend não conhece nenhuma origem pública. Hoje não existe link de
recuperação.

### 1.2 BFF e frontend (Next)
| Componente | Arquivo | Comportamento atual |
|---|---|---|
| Proteções | `src/server/bff/security.mjs` (`checkCsrf`: cabeçalho `x-prazoai-csrf: 1` + `Origin == PRAZOAI_APP_ORIGIN` em mutações; `NO_STORE`), `manager.mjs` (limite de corpo `PRAZOAI_BFF_MAX_BODY_BYTES`, `timeoutMs`, resultado `uncertain` → 504 `outcome: "unknown"`, sem repetição), `allowlist.mjs` | **[EXISTE]** |
| Rota pública modelo | `src/app/bff/public/invitations/lookup/route.ts` → `publicInvitationLookup` | **[EXISTE]** sem sessão, sem cookies; token só no **corpo**; aceita exatamente `{token}`; IP confiável repassado |
| Token em fragmento | `src/lib/integration/invite-token.mjs` (`#TOKEN`, `history.replaceState`, nunca em pathname/query/storage) | **[EXISTE]** padrão já auditado nos convites |
| Tela "Esqueci a senha" | `src/app/esqueci-senha/page.tsx` | **[LIMITAÇÃO]** demonstrativa (`setTimeout`, nenhuma chamada); no modo integrado, o `layout.tsx` mostra **"Indisponível nesta fase"** |
| Tela "Redefinir" | `src/app/redefinir-senha/[token]/page.tsx` | **[LIMITAÇÃO]** demonstrativa (tokens "demo/expirado/usado"); **token no caminho da URL** (histórico, logs de acesso, `Referer`); bloqueada no modo integrado |
| Rotas indisponíveis | `src/lib/integration/routes.mjs` → `UNAVAILABLE_PUBLIC = ["/esqueci-senha", "/redefinir-senha"]` | **[EXISTE]** |

### 1.3 Testes existentes (relevantes)
- `tests/test_auth_password_reset.py` (12): neutralidade, hash, troca sem login, token inválido,
  expirado e reutilizado, segundo pedido invalidando o primeiro, revogação de sessões, consumo
  concorrente, entrega padrão sem token.
- `test_auth_contract.py`: contrato memória × PostgreSQL.
- `test_auth_sql_concurrency.py` / `test_auth_sql_hardening.py` (PostgreSQL real):
  - reset × login, rehash e refresh;
  - dois resets do mesmo token; pedidos simultâneos;
  - expiração durante a espera;
  - mensagem com a expiração persistida;
  - falha antes do COMMIT sem entrega.
- **Experimento executado nesta entrega:** `pytest tests/test_auth_password_reset.py` na base →
  12 passaram (memória). Nenhum outro teste foi criado ou alterado.

---

## 2. Componentes propostos e responsabilidades **[PROPOSTA]**
```
Navegador ──► BFF (Next) ──────────────────────────────► FastAPI ─────────────────────► PostgreSQL
  /esqueci-senha        POST /bff/public/password/forgot     POST /auth/forgot-password    (tokens só como hash)
  /redefinir-senha#T    POST /bff/public/password/reset      POST /auth/reset-password
                        GET  /bff/public/password/status     GET  /auth/password-recovery/status
                                                                │
                                                                ▼ (depois da resposta)
                                                   RecoveryDispatcher (fila em memória, limitada)
                                                                │  busca usuário → emite token (P3)
                                                                ▼
                                                   EmailTransport: smtp | capture | disabled
                                                                │
                                         SMTP do provedor (futuro)  ·  capturador local (dev/CI)
```
| Componente | Responsabilidade |
|---|---|
| `EmailTransport` (Protocol) | enviar um `OutgoingEmail` já montado; implementações `SmtpTransport`, `DisabledTransport` |
| `PasswordResetEmailComposer` | montar assunto e corpo (texto, e HTML opcional) e o link `PUBLIC_APP_ORIGIN/redefinir-senha#TOKEN`; sem dados jurídicos |
| `RecoveryDispatcher` | fila em memória limitada e com prazo, com **um** worker; executa o pedido **fora** da requisição (contrato em §4.5) |
| `PasswordResetDelivery` (existente) | passa a ser implementado por um adaptador que usa o composer + transporte; o Noop continua como "desabilitado" |
| Rotas BFF públicas | `forgot`, `reset`, `status`, no padrão da consulta de convite |
| Telas | `/esqueci-senha` e `/redefinir-senha` (sem segmento de token), integradas ao BFF |

## 3. Caminho de uma requisição **[PROPOSTA]**
1. A pessoa envia o e-mail em `/esqueci-senha`. O navegador faz
   `POST /bff/public/password/forgot {email}`, com `x-prazoai-csrf` e Origin.
2. O BFF valida cabeçalho, Origin, tamanho e formato (exatamente `{email}`), repassa o IP
   confiável e chama `POST /auth/forgot-password`.
3. O backend:
   - aplica os limites por IP e por e-mail (só trabalho em memória, limitado);
   - **enfileira** o pedido (e-mail normalizado), sem consultar o banco nem montar o token;
   - responde **202** com a mensagem genérica.

   O caminho da requisição é o mesmo para conta existente e inexistente.
4. O worker do `RecoveryDispatcher`:
   - descarta o item se passou do prazo de fila (§4.5), antes de qualquer consulta;
   - busca o usuário (inexistente → descarta, com log só de contagem);
   - gera o token e chama `issue_replacing_active` (bloqueio, relógio pós-lock, expiração
     persistida, COMMIT);
   - só **depois do COMMIT** monta o e-mail e chama o transporte, com timeout.
5. A pessoa abre `https://<origem>/redefinir-senha#TOKEN`. A página lê o fragmento, remove-o com
   `history.replaceState` (sem requisição HTTP com o token) e o guarda **só em memória** (estado
   React).
6. A pessoa informa a nova senha. O navegador faz
   `POST /bff/public/password/reset {token, newPassword}`. O BFF chama `/auth/reset-password`, que
   executa a redefinição atômica existente.
7. **204** leva à tela "Senha redefinida — entre com a nova senha", sem login automático. Os
   cookies do BFF não são tocados por essa rota.

## 4. Alternativas e decisões **pendentes de aprovação**

### 4.1 Transporte: SMTP genérico × API de provedor
| | SMTP genérico (`smtplib` da biblioteca padrão) | API HTTP de provedor |
|---|---|---|
| Dependência nova | nenhuma | SDK ou cliente HTTP do provedor |
| Portabilidade | qualquer provedor ou relay SMTP; capturador local fala SMTP | acoplada ao provedor |
| Recursos | básicos (sem webhooks de entrega) | estatísticas, supressão, webhooks |
| Testes locais | capturador SMTP local, sem rede externa | exige simulação da API |
| Riscos | configurar TLS e timeouts corretamente | segredo de API; mudança de contrato do provedor |

**Recomendação (D-E1):** SMTP genérico com `smtplib` + `email.message.EmailMessage`
(`policy=email.policy.SMTP`). É a menor solução adequada: sem dependência e trocável por qualquer
provedor que aceite SMTP autenticado. A API de provedor fica para quando houver necessidade de
webhooks ou estatísticas.

### 4.2 Modo de entrega
| Alternativa | Como funciona | Consequências |
|---|---|---|
| A. Síncrona com timeout (como hoje, mas real) | `send` dentro da requisição, depois do COMMIT | simples; **piora a enumeração por tempo** (SMTP leva centenas de ms só para contas existentes); requisição presa ao provedor; timeout ≠ não entregue |
| B. **Segundo plano em memória, limitado** | requisição só valida, limita e enfileira; worker faz busca + emissão + envio | **mesmo caminho público** para conta existente e inexistente, sem banco e sem transporte na requisição; requisição não depende do provedor; **perde pedidos ao reiniciar** (ainda não emitidos ou não enviados); fila cheia descarta |
| C. Outbox durável **com token ou link** | tabela com o conteúdo a enviar; worker envia e marca | sobrevive a reinícios; **exige guardar o token** (cifrado) → muda o modelo de segurança (hoje o banco só tem hashes); chaves, acesso, retenção e migration |
| D. Outbox durável **de intenção** (sem token) | tabela com a intenção e `solicitado_em`; o worker emite o token **no momento do envio**. Duas variantes, abaixo | sobrevive a reinícios sem guardar segredo; exige migration, tabela nova, concorrência e retenção da intenção |

**Recomendação (D-E2):** **B** nesta fase.
- **Por quê:** o caminho público fica o mesmo para qualquer e-mail, sem consulta ao banco nem
  espera pelo transporte na requisição (garantia verificável; riscos residuais em §5). O banco
  continua só com hashes, sem tabela nova.
- **Consequência aceita:** um pedido pode se perder num reinício ou com fila cheia. A pessoa vê a
  mesma mensagem neutra e pode pedir de novo; o limite por e-mail continua valendo.
- **Evolução:** **D** é o caminho durável recomendado, caso a perda em reinício seja inaceitável,
  e exigiria um projeto e uma migration próprios.
- **Rejeitado agora:** C. Guardar o token, mesmo cifrado, exigiria aprovação explícita de:
  - criptografia autenticada (ex.: AES-GCM) com chave fora do banco, como segredo gerenciado;
  - rotação de chaves;
  - acesso restrito ao worker;
  - retenção curta (apagar ao enviar ou expirar);
  - nenhuma cópia em logs ou backups sem cifra.

**Variantes da outbox de intenção (D), só para comparação; nada a implementar agora:**

| | D1: guardar `user_id` | D2: guardar o **e-mail normalizado** e resolver a conta no worker |
|---|---|---|
| Consulta ao banco na requisição | **sim**, para achar o `user_id` (reintroduz diferença de caminho entre conta existente e inexistente) | não (a requisição só grava a intenção, igual para qualquer e-mail) |
| Dado pessoal em repouso | só de contas existentes | e-mails informados por qualquer pessoa, **inclusive inexistentes** (dado de terceiros; retenção curta obrigatória) |
| Abuso de armazenamento | limitado às contas existentes | qualquer e-mail gera linha: precisa de teto e limpeza agressiva |
| Mudança de e-mail entre pedido e envio | segue o `user_id` (envia ao e-mail atual) | resolve pelo e-mail informado (se mudou, nenhuma conta é encontrada) |
| Hash no lugar do e-mail | — | não resolve: o worker precisa do e-mail para buscar a conta, e não há coluna de busca por hash em `users` |

Em ambas, a intenção não contém token. A escolha só faria sentido junto com a decisão de tornar a
recuperação durável.

**Sem "exatamente uma vez":** cada pedido **processado** pelo worker gera **no máximo uma**
emissão de token (a unicidade do token ativo é garantida pelo banco). Um pedido descartado (fila
cheia, prazo vencido, reinício) não gera nenhuma. O **envio** é "no máximo uma tentativa por
token" na proposta B:
- um timeout depois do comando `DATA` do SMTP deixa a entrega **incerta** (pode ter chegado);
- repetir o envio do mesmo token poderia duplicar o e-mail;
- repetir a **emissão** invalidaria o token anterior.

A **unicidade do token ativo** garante no máximo **um token válido** por pessoa a cada instante.
Ela **não** garante processamento exatamente uma vez por intenção:
- dois pedidos geram dois tokens, em sequência, e só o último vale;
- um pedido perdido (reinício ou fila cheia) não gera nenhum;
- um envio incerto pode ter chegado ou não.

**Decisão pendente (D-E3):** sem repetição automática do envio. A pessoa pede de novo, dentro do
limite. Uma única repetição só para falhas **antes** da conexão (recusa de conexão) fica como
opção, se aprovada.

### 4.3 Captura local (desenvolvimento e testes)
| Alternativa | Uso |
|---|---|
| Transporte em memória (`CapturingDelivery`/`CapturingTransport`) | **[EXISTE]** em parte; testes unitários e de serviço |
| Capturador SMTP local com API HTTP (ex.: Mailpit em contêiner) | dev e CI: e-mail real via SMTP sem saída externa; o E2E lê o link pela API do capturador |
| Servidor SMTP em processo (ex.: biblioteca `aiosmtpd`) | testes de integração do `SmtpTransport` sem contêiner; exige dependência de **teste** |

**Recomendação (D-E4):**
- testes unitários e de serviço: transporte de captura em memória;
- testes do `SmtpTransport` e do E2E: capturador SMTP local como serviço de CI, numa imagem
  oficial com versão fixada, só em rede local;
- a escolha concreta da imagem fica para aprovação.

Transporte sem TLS só para o capturador em `localhost`/rede de serviço, com
`SMTP_ALLOW_INSECURE_LOCAL=true` e `ENVIRONMENT` em `development` ou `test`.

### 4.4 Indisponibilidade, reinício e entrega incerta
| Situação | Comportamento proposto |
|---|---|
| Transporte desabilitado (`EMAIL_TRANSPORT=disabled`) | `status` → `unavailable`; o pedido responde **503 `password_recovery_unavailable`** e não emite token. A tela continua "Indisponível". Não se finge envio. **Decisão D-E5:** pode virar 202 neutro, se a auditoria preferir |
| Provedor fora do ar ou timeout | o token já foi emitido e confirmado; o envio falha; log de categoria; a pessoa pede de novo; o token não enviado expira e a P5 remove |
| Fila cheia | pedido descartado (contador `queue_full`, sem destinatário); resposta neutra igual (§4.5) |
| Pedido que esperou demais | descartado **antes** de consultar o usuário ou emitir token (contador `queue_expired`) (§4.5) |
| Reinício ou encerramento com fila pendente | pendências descartadas e contadas no encerramento (§4.5); pedidos perdidos (B); só D resolveria |
| Resultado desconhecido no BFF (timeout do backend) | pedido: "Não foi possível confirmar; tente novamente em instantes" (sem repetição automática); reset: 504 `outcome: "unknown"` → "Não sabemos se a senha foi trocada. Tente entrar com a nova senha; se não funcionar, peça um novo link" |

### 4.5 Contrato do `RecoveryDispatcher` **[PROPOSTA]**

**Item da fila:** `(e-mail normalizado, enfileirado_em_monotônico, id_aleatório_do_pedido)`.
- O id só serve para correlacionar logs; nunca é derivado do e-mail.
- O e-mail fica só na memória do processo, nunca em log.

**Capacidade:** `RECOVERY_QUEUE_MAX` itens (padrão 100). `put_nowait`: fila cheia → item
descartado, contador `queue_full` e **a mesma resposta 202**.

**Prazo de permanência:** `RECOVERY_QUEUE_MAX_WAIT_SECONDS` (padrão 60; faixa 10–600), medido com
`time.monotonic()`, imune a ajustes do relógio de parede.
- Ao retirar um item, o worker compara `agora_monotônico − enfileirado_em` com o prazo.
- **Vencido → descartado ANTES de qualquer consulta ao usuário ou emissão de token** (contador
  `queue_expired`).
- O relógio injetável do domínio (wall clock) continua sendo usado só para a expiração do token.

**Um único worker nesta fase (D-E10):**
- a fila é FIFO e um único consumidor preserva a ordem de **retirada** por destinatário (e no
  geral);
- vários workers exigiriam particionar por destinatário (ex.: `hash(e-mail) mod N`, uma fila por
  worker), o que não é proposto agora;
- a vazão de um worker é suficiente para o volume previsto, que já é limitado por e-mail e por IP.

**Ciclo de vida:**
1. **Inicialização:** no `lifespan` da aplicação, **depois** de criar o engine e os repositórios,
   e só com `EMAIL_TRANSPORT=smtp`. A thread é criada uma vez, com nome fixo. `daemon=True` serve
   só para não impedir a saída do processo no caso não limpo; **não** é mecanismo de encerramento
   (§4.7). Com `disabled`, não há worker e `status` responde `available=false`.
2. **Falha ao processar um item:** a exceção é capturada, gera log só da categoria (`issue_failed`,
   `transport_timeout`, `transport_refused`, `transport_error`, `deadline_exceeded`) e o worker
   segue para o próximo item.
3. **Morte inesperada da thread** (defeito):
   - o despachante passa a `available=false`, e novos pedidos recebem 503
     `password_recovery_unavailable`;
   - pendências são descartadas e contadas;
   - **nenhuma thread substituta é criada automaticamente** (sem crescimento ilimitado de threads);
     a recuperação volta com o reinício do processo.
4. **Encerramento:** protocolo em etapas, em §4.7.

**Quatro ordens diferentes, que não se confundem:**

| Ordem | Quem define | Garantia |
|---|---|---|
| Solicitação | chegada das requisições ao processo | sem relação garantida com a percepção da pessoa (requisições concorrentes) |
| Emissão do token | ordem de retirada da fila (um worker) | FIFO por processo; o último emitido é o **único** válido (P3) |
| Aceitação SMTP | ordem de envio (um worker) | igual à da emissão, quando ambas têm sucesso |
| Chegada à caixa | provedor e destinatário | **nenhuma**: atrasos e reordenações são normais |

Por isso o texto do e-mail **não** diz "use o e-mail mais recente". O corpo informa:
- "gerado em" (instante da emissão) e "válido até" (expiração persistida), no fuso configurado;
- que, se chegarem vários e-mails, **apenas o link gerado por último funciona**, que os outros
  abrirão "link inválido ou substituído" e que a tela oferece pedir outro.

**Pedido enfileirado e redefinição de senha:**
- se um pedido ainda estiver na fila quando a pessoa conclui uma redefinição (com outro link), o
  worker processa o pedido depois;
- **um novo token válido é emitido e enviado**;
- o reset **não cancela intenções pendentes** nesta proposta, porque nada disso está implementado
  nem é prometido;
- o e-mail vai para o titular da conta e é uma recuperação legítima pedida antes; o efeito colateral
  é um link válido a mais, até expirar.

O cancelamento é opcional (D-E9): por exemplo, descartar itens enfileirados antes da última troca
de credencial. Ele exigiria comparar instantes de parede com a troca persistida.

### 4.6 Limites de tempo efetivamente garantidos
| Etapa | Limite | Garantido por | Observação |
|---|---|---|---|
| Requisição pública | sem banco e sem transporte | caminho do código (§5) | só validação, limitadores e `put_nowait` |
| Espera na fila | o item **não é processado** depois de `RECOVERY_QUEUE_MAX_WAIT_SECONDS` | verificação ao retirar | um item pode **ficar** na fila mais tempo se o worker estiver bloqueado, mas é descartado ao ser retirado; a memória é limitada por `RECOVERY_QUEUE_MAX` |
| Busca + emissão (banco) | por comando: `RECOVERY_DB_LOCK_TIMEOUT_MS` (1000) e `RECOVERY_DB_STATEMENT_TIMEOUT_MS` (3000), aplicados com `SET LOCAL` na transação do worker | PostgreSQL | mais curtos que os da API (5 s/15 s); a etapa tem poucos comandos; erro → falha de categoria, sem repetição; no encerramento, também cancelamento ativo (§4.7) |
| Envio SMTP inteiro (DNS, conexão, TLS, autenticação, `DATA`) | `SMTP_SEND_DEADLINE_SECONDS` (30), **prazo total** | subprocesso supervisionado (D-E8, abaixo) | no vencimento, o processo filho é encerrado e coletado; resultado **incerto** se já tinha passado de `DATA` |
| Cada operação SMTP dentro do filho | `SMTP_TIMEOUT_SECONDS` | timeout de socket do `smtplib` | só por operação; o prazo total é dado pelo supervisor, não por este timeout |
| Encerramento da aplicação | `RECOVERY_SHUTDOWN_GRACE_SECONDS` (5) para o caminho limpo | protocolo de §4.7 | ver §4.7 para o que é garantido em cada caminho |

**Prazo total do envio: decisão D-E8 revisada.**

*Por que o temporizador não basta:* fechar o socket com um `Timer` só age sobre um socket já
publicado. Ele **não** cobre:
- a resolução DNS (`getaddrinfo`, bloqueante e sem timeout no `smtplib`);
- a conexão antes de o socket ser atribuído ao objeto SMTP;
- a **substituição do socket** durante STARTTLS (o `Timer` pode fechar o socket antigo enquanto o
  novo, cifrado, continua bloqueado);
- a corrida entre o vencimento e a publicação do socket.

Por isso o temporizador **não é usado como garantia**, nem como mecanismo auxiliar.

*Solução escolhida: isolamento em subprocesso supervisionado.* Para cada envio, o worker inicia
um processo filho dedicado:
- **Início:** `subprocess.Popen` com o caminho absoluto de um script mínimo de envio e
  `start_new_session=True`; o script não importa `app.db` nem cria engine, conexões ou
  repositórios.
- **Ambiente:** mínimo (`PATH`, localidade), **sem** `DATABASE_URL`, `SMTP_PASSWORD` nem outros
  segredos herdados.
- **Entrada:** configuração SMTP (incluindo a senha) e mensagem (destinatário, assunto, corpo com
  o link) chegam **só pela entrada padrão** (pipe), em JSON. Nunca por argumentos (visíveis em
  `ps`), arquivos temporários ou variáveis de ambiente.
- **No filho:**
  - executa DNS, conexão, TLS, autenticação e envio com `smtplib`, mantendo o timeout por
    operação;
  - desativa core dumps (`RLIMIT_CORE=0`);
  - não configura logging;
  - escreve na saída padrão **só** uma categoria de resultado (`accepted`, `refused`, `tls_error`,
    `auth_error`, `timeout`, `error`).
- **Supervisão:** o pai chama `communicate(input, timeout=SMTP_SEND_DEADLINE_SECONDS)`. No
  vencimento:
  1. `SIGTERM` ao grupo do processo;
  2. espera curta (1 s);
  3. `SIGKILL`;
  4. `wait()` para coletar o processo (sem zumbis);
  5. resultado `deadline_killed`, tratado como entrega **incerta** e sem repetição.
- **Saída de erro:** o `stderr` do filho é descartado. Só a categoria vai para o log do pai.
- **Concorrência:** com um worker, há no máximo **um** filho por vez (sem crescimento de
  processos).
- **Custos:**
  - inicializar o interpretador por e-mail (ordem de 50–150 ms) e memória transitória do filho
    (dezenas de MB);
  - mais código de supervisão;
  - testes com servidores SMTP e DNS controlados.

  São aceitáveis para o volume limitado da recuperação.

*Alternativa mantida para comparação:* `smtplib` na própria thread, com timeout por operação e
cancelamento cooperativo (a flag de parada é checada entre as etapas).
- Mais leve, mas **sem limite total garantido**: um DNS lento ou um servidor que responde devagar
  dentro do timeout por operação prolongam o envio.
- Se a auditoria preferir essa alternativa, o documento passa a declarar explicitamente a ausência
  de prazo total.

*Rejeitado:* abandonar a thread bloqueada e criar substituta (crescimento ilimitado de threads e
conexões).

### 4.7 Protocolo de encerramento (D-E11 revisada) **[PROPOSTA]**

**Estados do despachante:** `running` → `stopping` → `stopped_clean` ou `stopped_unclean`.

1. **Parar a admissão e descartar a fila, de forma coordenada.** Sob o mesmo `Lock` que protege o
   enfileiramento, o despachante passa a `stopping`, e todo `submit` posterior recebe 503. Ainda
   sob o lock, a fila é drenada e os itens são contados em `shutdown_discarded`, sem
   destinatários. Assim não há corrida em que um pedido entre na fila depois da drenagem.
2. **Solicitar a parada do item em curso.** O despachante sinaliza um `threading.Event` de parada
   e age conforme a etapa registrada pelo worker:
   - *fila ou entre etapas:* nada a fazer além do evento;
   - *banco:* o worker publica o PID do processo PostgreSQL da sua conexão
     (`pg_backend_pid()`) ao iniciar a etapa. O despachante, por **outra** conexão curta, chama
     `pg_cancel_backend(pid)` e repete a cada 200 ms enquanto a etapa durar (um cancelamento que
     chega entre dois comandos não age). O comando cancelado gera erro, a transação sofre
     **rollback** e a conexão é devolvida pelo gerenciador de contexto;
   - *SMTP:* o despachante encerra o grupo do processo filho (`SIGTERM`, depois `SIGKILL`) e o
     worker coleta o processo.
3. **Impedir que o worker inicie nova etapa depois de reconhecer a parada.** O worker checa o
   evento antes de **cada** etapa: retirar item, abrir a transação de emissão, iniciar o
   subprocesso SMTP.
   - Com o evento sinalizado, não emite token nem tenta SMTP, e termina.
   - **Corrida documentada:** se a emissão tiver feito COMMIT pouco antes do reconhecimento, o
     token existe mas não é enviado. Ele expira e a P5 o remove; a pessoa pede outro link.
4. **Devolver conexões antes de declarar encerramento limpo.** O despachante espera o fim **da
   thread** com `join(RECOVERY_SHUTDOWN_GRACE_SECONDS)`. O resultado só é `stopped_clean` se:
   - `is_alive()` for falso **e**
   - o pool não tiver conexões emprestadas pelo worker (contador próprio do despachante e
     `checkedout()`).

   Só então o `lifespan` segue para `engine.dispose()`, que fecha as conexões ociosas do pool.
5. **Caso em que o worker não termina** (`stopped_unclean`):
   - registro `dispatcher_stop_unclean`, com a etapa em curso (só a categoria);
   - **nenhuma** tentativa de cancelar por `dispose`: `dispose` não cancela uma transação em curso
     nem fecha uma conexão emprestada;
   - nenhuma thread substituta;
   - o `lifespan` conclui, e o processo termina (a thread `daemon` não segura a saída);
   - se ainda houver transação aberta, o PostgreSQL faz rollback ao perceber o fechamento da
     conexão, no fim do processo;
   - se houver filho SMTP, ele já recebeu `SIGKILL` (item 2).

**O que é garantido, e o que não é:**
- **Prazo rígido do encerramento da aplicação:** garantido, porque o `lifespan` nunca espera mais
  que o prazo de graça e o processo sai.
- **Encerramento limpo** (thread terminada e conexões devolvidas antes do `dispose`): garantido
  **somente** quando o worker reconhece a parada dentro do prazo.
  - O desenho torna esse o caso esperado: as etapas são canceláveis (cancelamento ativo do SQL e
    morte do filho SMTP).
  - Mas não é absoluto: uma thread presa num ponto não cancelável do próprio processo, como a
    abertura de conexão com o banco, termina pelo caminho não limpo.
- **Não prometemos os dois simultaneamente.** Priorizamos o prazo rígido e **informamos**
  explicitamente quando o encerramento não foi limpo.

## 5. Falhas, concorrência e segurança## 5. Falhas, concorrência e segurança
| Tema | Garantia | Origem |
|---|---|---|
| Resposta neutra (verificável) | **mesmo caminho público** para qualquer e-mail: validação → limite por IP → limite por e-mail → `put_nowait` → 202 com a mesma mensagem. **Sem consulta ao banco e sem espera pelo transporte na requisição** | **[PROPOSTA]**; teste estrutural planejado (§9) |
| Tempo (riscos residuais) | sem `sleep` fixo e **sem promessa de ausência absoluta de enumeração**. Riscos residuais: o worker disputa CPU (inclusive o GIL), pool de conexões e locks do banco com as requisições; um processamento pesado de contas existentes pode alterar a latência **de outras** requisições. A fila cheia descarta e responde igual, mas sua ocupação depende da carga | **[PROPOSTA]** + riscos documentados |
| Abuso e custo | limite por **IP** (novo) e por **e-mail** (existente), antes de enfileirar; fila com teto (`RECOVERY_QUEUE_MAX`) e prazo (`RECOVERY_QUEUE_MAX_WAIT_SECONDS`); **um** worker; chaves dos limitadores com teto (`max_keys`) | **[PROPOSTA]** + **[EXISTE]** |
| Limite por destinatário | o limite por e-mail também protege a caixa da vítima (bombardeio); conta pedidos para e-mails **inexistentes** do mesmo jeito | **[EXISTE]** |
| Falha depois do COMMIT | token emitido e válido até expirar, sem e-mail; nada é desfeito | **[EXISTE]** + **[PROPOSTA]** log de categoria |
| Segundo pedido invalida o primeiro | `issue_replacing_active` (bloqueio + índice parcial) | **[EXISTE]** |
| Mensagens fora de ordem | a chegada à caixa não segue a emissão (§4.5). Só o token emitido por último é válido; os outros abrem "link inválido ou substituído". O corpo traz "gerado em" e "válido até", e explica que só o link gerado por último funciona | **[EXISTE]** semântica + **[PROPOSTA]** texto |
| Unicidade × exatamente uma vez | um token válido por pessoa a cada instante; **não** um processamento exatamente uma vez por intenção (§4.2) | **[EXISTE]** + esclarecimento |
| Token expirado, usado ou invalidado | `invalid_reset_token` (400), igual para os três, sem distinguir; pré-validação sem Argon2 | **[EXISTE]** |
| Redefinições concorrentes | `complete_reset` com bloqueio e revalidação; uma vence, a outra recebe 400 | **[EXISTE]** (testado com PostgreSQL) |
| Sessões | o reset revoga todas e incrementa `credential_version`; sem login automático | **[EXISTE]** |
| Logs | nunca token, link, senha, corpo, credenciais SMTP nem e-mail completo; só `user_id`, categoria do resultado (`sent`, `transport_timeout`, `transport_refused`, `queue_full`, `unknown_user`) e duração | **[PROPOSTA]** + `__repr__` existente |
| Erros SMTP | capturar e registrar só a **classe** da exceção (respostas do servidor podem conter o destinatário) | **[PROPOSTA]** |
| Origem do link | `PUBLIC_APP_ORIGIN` validada no startup (só a origem; `https` obrigatório fora de loopback; igual ao `PRAZOAI_APP_ORIGIN` do BFF, conferido em teste); **nunca** derivada de `Host` ou de cabeçalhos encaminhados | **[PROPOSTA]** |
| Fragmento | o token vai em `#TOKEN`, que não é enviado ao servidor; a página remove-o imediatamente e o mantém só em memória; nunca em `localStorage`, `sessionStorage`, cookie, query ou caminho | **[PROPOSTA]** (reaproveita o padrão de `invite-token.mjs`) |
| Caminho antigo `/redefinir-senha/[token]` (aplicação) | é removido: a aplicação **não gera nem processa** novos links nesse formato. Uma requisição antiga recebe página estática com `Referrer-Policy: no-referrer`, sem eco do token e sem chamadas ao BFF; a aplicação não registra o caminho em seus próprios logs | **[PROPOSTA]** |
| Caminho antigo (operação) | a remoção **não impede** que proxy, CDN, hospedagem ou o servidor HTTP registrem a URL recebida. Isso exige configuração operacional (filtrar ou mascarar `/redefinir-senha/*` nos logs de acesso), fora do código e para a entrega de prontidão. Hoje nenhum link real foi emitido nesse formato (só tokens demonstrativos) | operação futura |
| SMTP | `SMTP_SECURITY=starttls` (padrão) ou `tls` (implícito), com `ssl.create_default_context()` (verifica certificado e nome); `none` só com a exceção local de §4.3; timeout de conexão e operação (`SMTP_TIMEOUT_SECONDS`); autenticação só depois do TLS | **[PROPOSTA]** |
| Injeção de cabeçalhos | `EmailMessage` com `policy.SMTP` (recusa CR/LF em cabeçalhos); destinatário vindo do banco (e-mail validado e normalizado); assunto constante; `EMAIL_FROM` validado no startup | **[PROPOSTA]** |
| Garantias da P3 | inalteradas: emissão e redefinição atômicas, relógio pós-lock, D6 (409), hashes apenas | **[EXISTE]** |

**Multiprocesso [LIMITAÇÃO mantida]:** limitadores e fila são por processo, como hoje. Com vários
processos, os limites valem por processo. A solução distribuída (ex.: Redis) está fora do escopo.

## 6. BFF e interface **[PROPOSTA]**

### 6.1 Rotas (allowlist explícita, sem passar pelo proxy autenticado)
| Rota BFF | Corpo aceito (exato) | Backend | Respostas para a interface |
|---|---|---|---|
| `GET /bff/public/password/status` | — | `GET /auth/password-recovery/status` → `{available: bool}` | `{available}`, sem tipo de transporte, host ou remetente |
| `POST /bff/public/password/forgot` | `{email}` (≤ 254) | `/auth/forgot-password` | 202 neutro · 429 `rate_limited` (`Retry-After`) · 503 `password_recovery_unavailable` · 503/504 sem confirmação → "tente novamente em instantes" |
| `POST /bff/public/password/reset` | `{token, newPassword}` | `/auth/reset-password` | 204 · 400 `invalid_reset_token` · 422 senha fraca (token **não** consumido) · 429 · 504 `outcome: "unknown"` |

Todas as rotas:
- exigem `x-prazoai-csrf: 1`, e as mutações também `Origin == PRAZOAI_APP_ORIGIN`;
- respeitam o limite de corpo e o timeout;
- respondem com `no-store`;
- **não leem, não criam e não apagam cookies de sessão** (uma sessão BFF existente nesse
  navegador continua intacta até a próxima renovação falhar pela revogação, o que é correto);
- repassam o IP confiável e nada registram do corpo;
- não repetem automaticamente uma mutação incerta.

### 6.2 Estados das telas
- **`/esqueci-senha`:**
  - `carregando-disponibilidade`;
  - `indisponível` (quando `available=false`, mantém o aviso atual, sem formulário);
  - `formulário` → `enviando` → `aceito` ("Se houver uma conta com esse e-mail, enviaremos um
    link. Verifique a caixa de entrada e o spam."), que **nunca** diz "e-mail enviado";
  - `limite` (com o tempo de espera);
  - `sem-confirmação`.
- **`/redefinir-senha`:**
  - `sem-token` (fragmento ausente ou inválido → "link incompleto");
  - `formulário` → `enviando` → `sucesso` ("Senha redefinida. Entre com a nova senha.", com link
    para `/login`, sem login automático);
  - `link-inválido` (inválido, expirado, usado ou substituído, com a mesma mensagem e link para
    pedir outro);
  - `senha-fraca` (o token segue em memória para nova tentativa);
  - `limite`;
  - `resultado-desconhecido`.
- O token nunca aparece no DOM, em atributos, em analytics nem em mensagens de erro. Recarregar a
  página perde o token (ele só vivia em memória), e isso é documentado na própria tela.

## 7. Configuração e segredos **[PROPOSTA]**
| Variável | Exemplo/padrão | Regras |
|---|---|---|
| `EMAIL_TRANSPORT` | `disabled` (padrão) \| `smtp` | `disabled` mantém o comportamento atual (Noop) |
| `PUBLIC_APP_ORIGIN` | `http://localhost:3000` (dev) | obrigatória com `smtp`; só a origem; `https` fora de loopback |
| `EMAIL_FROM` | `PrazoAI <nao-responda@exemplo.com>` | validado (endereço único, sem CR/LF) |
| `SMTP_HOST` / `SMTP_PORT` | `localhost` / `1025` (capturador) | obrigatórios com `smtp` |
| `SMTP_SECURITY` | `starttls` \| `tls` \| `none` | `none` só com `SMTP_ALLOW_INSECURE_LOCAL=true`, host local e `ENVIRONMENT` em `development` ou `test` |
| `SMTP_USERNAME` / `SMTP_PASSWORD` | — | `SecretStr`; nunca em logs, erros ou `/status`; exigem TLS |
| `SMTP_TIMEOUT_SECONDS` | 10 (2–30) | conexão e operações |
| `RECOVERY_QUEUE_MAX` | 100 (10–10000) | teto da fila; cheia → descarte neutro |
| `RECOVERY_QUEUE_MAX_WAIT_SECONDS` | 60 (10–600) | prazo de permanência (relógio monotônico) |
| `RECOVERY_SHUTDOWN_GRACE_SECONDS` | 5 (1–60) | espera pelo caminho limpo no encerramento (§4.7) |
| `RECOVERY_DB_LOCK_TIMEOUT_MS` / `RECOVERY_DB_STATEMENT_TIMEOUT_MS` | 1000 / 3000 | `SET LOCAL` na transação do worker |
| `SMTP_SEND_DEADLINE_SECONDS` | 30 (5–120) | prazo total do subprocesso de envio (D-E8) |
| (sem `EMAIL_WORKERS`) | 1 worker fixo | D-E10 |
| `AUTH_FORGOT_IP_MAX_REQUESTS` / `_WINDOW_SECONDS` | 10 / 900 | limite novo por IP |

**Segredos:** só por variáveis de ambiente ou gerenciador de segredos (futuro), nunca no
repositório, em `.env.example` com valores reais ou em artefatos. `hide_input_in_errors` (P3)
continua cobrindo os erros de validação. Produção segue bloqueada.

## 8. Plano de implementação (entregas pequenas, cada uma com auditoria)
| # | Entrega | Critérios de aceite |
|---|---|---|
| E1 | Configuração + `EmailTransport` + `SmtpTransport` **em subprocesso supervisionado** + composer (backend, ainda sem usar no fluxo) | validação completa no startup (TLS, origem, remetente); prazo total cobrindo DNS, conexão e TLS; nenhum segredo ou token em argumentos, arquivos, ambiente ou logs; processo sempre coletado; nenhuma mudança de comportamento com `disabled` |
| E2 | `RecoveryDispatcher` (§4.5) + caminho de requisição sem banco + limite por IP + `status` | resposta pública sem banco e sem transporte (teste estrutural); prazo de fila, fila cheia, falha e morte do worker; protocolo de encerramento de §4.7 (admissão coordenada, cancelamento ativo do SQL, nenhuma etapa nova após a parada, distinção limpo/não limpo); um worker; garantias da P3 intactas (suítes atuais verdes) |
| E3 | Capturador SMTP local no CI + testes de integração do transporte e do fluxo com PostgreSQL | e-mail recebido no capturador com o link correto; falha e timeout do transporte; nenhum token em logs |
| E4 | Rotas BFF públicas (`status`, `forgot`, `reset`) | allowlist; CSRF e Origin; corpo exato; `no-store`; cookies intocados; resultado desconhecido sem repetição; testes de integração BFF × FastAPI |
| E5 | Telas integradas + remoção de `/redefinir-senha/[token]` + E2E | E2E: pedido → capturador → link → nova senha → senha antiga recusada → nova aceita → sessões anteriores revogadas; nenhum token em URL de requisição, storage ou logs |
| E6 | Documentação operacional e revisão de observabilidade | doc atualizado; roteiro de operação do transporte |

Cada entrega preserva:
- a imagem oficial do Playwright e as proteções dos bancos descartáveis;
- os limites de taxa e a ausência de retries;
- a validação completa na árvore final, com artefatos reproduzíveis.

## 9. Matriz requisito → teste (**planejado**, salvo indicação)

"Existe" = já implementado e executado na base. "Planejado" = só desenho, ainda não escrito nem
executado. Nesta entrega nenhum teste novo foi escrito ou executado.
| Requisito | Teste | Situação |
|---|---|---|
| Neutralidade (existente × inexistente) | resposta e caminho idênticos; worker descarta inexistente | resposta: **existe** (`test_auth_password_reset`); caminho: planejado (E2) |
| Token só como hash | inspeção do banco | **existe** (P3) |
| Segundo pedido invalida o primeiro | serviço + PostgreSQL | **existe** |
| Fora de ordem | dois e-mails no capturador; o mais antigo recusado, o mais novo aceito | planejado (E3/E5) |
| Expirado, usado, invalidado | serviço + E2E | serviço: **existe**; E2E: planejado |
| Resets concorrentes | PostgreSQL real com gates | **existe** |
| Sessões revogadas, senha antiga recusada | serviço; E2E pelo navegador | serviço: **existe**; E2E: planejado |
| Falha e timeout do transporte | capturador indisponível; servidor SMTP lento (timeout) | planejado (E3) |
| TLS e certificado | `SmtpTransport` recusa `none` fora da exceção local; contexto verifica o certificado | planejado (E1) |
| Injeção de cabeçalhos | destinatário ou remetente com CR/LF recusado | planejado (E1) |
| Origem do link | `PUBLIC_APP_ORIGIN` inválida recusada; `Host` forjado não altera o link | planejado (E1/E2) |
| Limites por IP e por e-mail, estado limitado | serviço com relógio injetável | e-mail: **existe**; IP: planejado (E2) |
| Fila cheia e reinício | descarte com contador; resposta neutra | planejado (E2) |
| Pedido vencido na fila não emite token | relógio monotônico controlado; worker retira o item vencido; nenhuma consulta a `users` e nenhuma linha em `password_reset_tokens` | planejado (E2) |
| Fila cheia + transporte indisponível | fila no teto com o transporte recusando conexão; 202 neutro; contadores `queue_full` e `transport_refused`; memória não cresce | planejado (E2/E3) |
| Encerramento durante envio | servidor SMTP lento em curso; encerramento espera no máximo o prazo de graça; pendências descartadas e contadas; engine encerrado depois; nenhum destinatário em logs | planejado (E2/E3) |
| Falha e morte do worker | exceção por item: worker segue; morte da thread: `available=false`, 503, nenhuma thread substituta, número de threads constante | planejado (E2) |
| Dois pedidos do mesmo destinatário em ordem controlada | gates no worker: emissão na ordem de retirada; só o segundo token vale; ambos chegam ao capturador e o primeiro link é recusado | planejado (E3) |
| Pedido pendente atravessando uma redefinição | item retido por gate; reset concluído com outro link; ao liberar, novo token emitido e enviado (sem cancelamento prometido); senha redefinida continua válida | planejado (E3) |
| SMTP lento: por operação × total | servidor que responde dentro do timeout por operação, mas prolonga o envio: o supervisor encerra o filho no prazo total; resultado `deadline_killed` (incerto), sem repetição | planejado (E1/E3) |
| Prazo vencendo antes de existir socket | resolução DNS lenta simulada no processo filho de teste; o supervisor encerra no prazo total; processo coletado | planejado (E1) |
| Vencimento durante conexão e negociação TLS | servidor de teste que aceita TCP e não responde ao banner, ou que trava o handshake TLS depois de STARTTLS; encerramento no prazo total | planejado (E1) |
| Segredos fora de argumentos, arquivos e ambiente | inspeção da linha de comando e do ambiente do filho; nenhum arquivo temporário criado; senha e token ausentes de logs e `stderr` | planejado (E1) |
| Encerramento enquanto o worker aguarda bloqueio SQL | conexão de controle segura a linha do usuário; worker bloqueado na emissão; encerramento → `pg_cancel_backend` → rollback; nenhum token emitido; conexão devolvida | planejado (E2, PostgreSQL real) |
| Nada novo após a parada reconhecida | gates entre etapas: evento sinalizado antes da emissão ou do SMTP; nenhuma linha em `password_reset_tokens` e nenhum processo filho iniciado | planejado (E2) |
| Caminho limpo | encerramento com o worker ocioso, na etapa de banco ou na de SMTP: `is_alive()` falso, `checkedout()` zero antes do `dispose`, estado `stopped_clean` | planejado (E2) |
| Caminho não limpo explícito | worker preso num ponto não cancelável simulado: `stopped_unclean` registrado no prazo de graça, `dispose` não usado como cancelamento, nenhuma thread substituta, `lifespan` concluído no prazo | planejado (E2) |
| Admissão coordenada | `submit` concorrente com o encerramento: nenhum item entra depois da drenagem; todos os descartes contados | planejado (E2) |
| Resposta pública sem banco e sem transporte | engine e transporte instrumentados para falhar se tocados durante a requisição; 202 para e-mail existente e inexistente | planejado (E2) |
| Token fora de URLs, storage e logs | E2E inspecionando requisições, `localStorage`, `sessionStorage`, cookies e logs | planejado (E5) |
| Proteções do BFF | CSRF, Origin, corpo, `no-store`, cookies intocados, resultado desconhecido | padrão **existe** (convites); rotas novas: planejado (E4) |
| Isolamento entre usuários | token de A não redefine B; pedidos de A não afetam B | parcialmente **existe** (serviço); E2E planejado |

## 10. Limitações deste projeto
- Proposta B perde pedidos em reinício ou com fila cheia, de forma deliberada e documentada.
- Limites e fila são por processo.
- Sem webhooks nem confirmação de entrega pelo provedor ("aceito pelo servidor SMTP" ≠
  "entregue na caixa").
- Nenhum provedor real foi avaliado com credenciais. A escolha do provedor e do domínio de envio
  (SPF, DKIM, DMARC) fica para a entrega de prontidão de produção.
- Nenhum experimento de SMTP foi executado nesta entrega.
- Com D-E8 (subprocesso), o envio tem prazo total, mas custa um processo por e-mail. Na
  alternativa sem subprocesso, **não há** limite total garantido.
- Encerramento: prazo rígido garantido; encerramento **limpo** só quando o worker reconhece a
  parada dentro do prazo. O caso não limpo é informado, não escondido (§4.7).
- Uma emissão confirmada pouco antes do reconhecimento da parada deixa um token que não será
  enviado (expira e é removido pela P5).
- Neutralidade de tempo: garantida só no **caminho** da requisição. Disputa de CPU, banco e fila
  são riscos residuais; não há promessa de ausência absoluta de enumeração.
- Logs de proxies e hospedagem dependem de configuração operacional (rota antiga).
- O reset não cancela pedidos pendentes (D-E9).

## 11. Glossário
- **Outbox:** tabela de mensagens pendentes gravada na mesma transação da operação, processada
  depois.
- **Entrega incerta:** o transporte não confirma; a mensagem pode ou não ter chegado.
- **Capturador SMTP:** servidor local que recebe e guarda e-mails sem repassá-los.
- **Fragmento:** parte da URL depois de `#`, não enviada ao servidor.
- **STARTTLS / TLS implícito:** criptografia negociada depois da conexão (porta 587) ou desde o
  início (porta 465).
- **Enumeração:** descobrir se uma conta existe a partir de diferenças de resposta ou de tempo.

## 12. Decisões que aguardam aprovação
| ID | Decisão | Recomendação |
|---|---|---|
| D-E1 | Transporte | SMTP genérico (biblioteca padrão) |
| D-E2 | Modo de entrega | B (segundo plano em memória, limitado, **temporário**) com o contrato de §4.5; D (D1 ou D2) como evolução durável; C rejeitado sem aprovação de segurança |
| D-E3 | Repetição do envio | nenhuma automática (opcional: 1 só para falha antes da conexão) |
| D-E4 | Captura local | transporte em memória (unitário) + capturador SMTP em contêiner (integração/E2E) |
| D-E5 | Pedido com transporte desabilitado | 503 `password_recovery_unavailable` + `status` (alternativa: 202 neutro) |
| D-E6 | Caminho antigo `/redefinir-senha/[token]` | remover da aplicação (página estática sem eco e com `no-referrer`); mascarar nos logs de proxy e hospedagem como item operacional |
| D-E7 | Origem do link | `PUBLIC_APP_ORIGIN` no backend, igual à do BFF, validada |
| D-E8 | Prazo total do envio SMTP | **subprocesso supervisionado** com `SMTP_SEND_DEADLINE_SECONDS` (`SIGTERM` → `SIGKILL` → coleta; segredos e token só pela entrada padrão); alternativa: `smtplib` na thread **sem** limite total, declarado; temporizador que fecha o socket **não** é garantia e não é usado |
| D-E9 | Pedido pendente × redefinição | não cancelar nesta fase (comportamento documentado); cancelamento como opção futura |
| D-E10 | Workers | exatamente um nesta fase; particionar por destinatário só se houver necessidade comprovada |
| D-E11 | Prazo de fila e encerramento | `RECOVERY_QUEUE_MAX_WAIT_SECONDS=60`; protocolo de §4.7 (admissão e drenagem sob lock, evento de parada, `pg_cancel_backend`, morte do filho SMTP, `stopped_clean` só com a thread terminada e as conexões devolvidas, `stopped_unclean` explícito); prazo rígido priorizado sobre encerramento limpo |

## 13. Roteiro de apresentação (TCC, cerca de 5 minutos)
1. **Ponto de partida (45 s):** a recuperação já é segura no banco (token só como hash, um ativo
   por pessoa, redefinição atômica que derruba as sessões), mas nenhum e-mail sai.
2. **O risco do caminho ingênuo (1 min):** mandar e-mail dentro da requisição deixaria a resposta
   mais lenta só para contas que existem. Um atacante descobriria e-mails cadastrados pelo tempo.
3. **A proposta (1 min 15 s):** a requisição só valida, limita e enfileira. Um worker emite o token
   e envia por SMTP com TLS. O link usa a origem configurada e o token vai no fragmento, que nunca
   chega ao servidor.
4. **Falhas honestas (1 min):** não prometemos "exatamente uma vez". Se o envio falha, a pessoa
   pede outro link; se o reinício perde um pedido, a mensagem neutra continua verdadeira. Guardar
   o token para reenviar exigiria cifra e gestão de chaves, por isso fica para decisão.
5. **Como vamos provar (1 min):** um capturador SMTP local no CI recebe o e-mail; o navegador abre
   o link, troca a senha e confirma que a senha antiga e as sessões antigas deixaram de valer.
   Também mostramos o que **não** prometemos: ausência absoluta de enumeração, ordem de chegada
   dos e-mails, ou encerramento sempre limpo. Garantimos o prazo do encerramento e avisamos quando
   ele não foi limpo.
