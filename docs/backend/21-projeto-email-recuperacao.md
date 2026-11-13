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
| `RecoveryDispatcher` | fila em memória limitada + worker(s); executa o pedido **fora** da requisição (§4.2) |
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
| B. **Segundo plano em memória, limitado** | requisição só valida, limita e enfileira; worker faz busca + emissão + envio | tempo da requisição igual para conta existente e inexistente; requisição não depende do provedor; **perde pedidos ao reiniciar** (ainda não emitidos ou não enviados); fila cheia descarta |
| C. Outbox durável **com token ou link** | tabela com o conteúdo a enviar; worker envia e marca | sobrevive a reinícios; **exige guardar o token** (cifrado) → muda o modelo de segurança (hoje o banco só tem hashes); chaves, acesso, retenção e migration |
| D. Outbox durável **de intenção** (sem token) | tabela só com `(user_id, solicitado_em)`; o worker emite o token **no momento do envio** | sobrevive a reinícios sem guardar segredo; mas exige migration e tabela nova, além de definir concorrência e retenção da intenção |

**Recomendação (D-E2):** **B** nesta fase.
- **Por quê:** resolve a neutralidade de tempo, mantém o banco só com hashes e não introduz
  tabela nova.
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

**Sem "exatamente uma vez":** a operação de negócio (emitir um token) acontece uma vez por
pedido, com unicidade garantida pelo banco. O **envio** é "no máximo uma tentativa por token" na
proposta B:
- um timeout depois do comando `DATA` do SMTP deixa a entrega **incerta** (pode ter chegado);
- repetir o envio do mesmo token poderia duplicar o e-mail;
- repetir a **emissão** invalidaria o token anterior.

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
| Fila cheia | pedido descartado (métrica e log), resposta neutra igual |
| Reinício com fila pendente | pedidos perdidos (B); documentado; só D resolveria |
| Resultado desconhecido no BFF (timeout do backend) | pedido: "Não foi possível confirmar; tente novamente em instantes" (sem repetição automática); reset: 504 `outcome: "unknown"` → "Não sabemos se a senha foi trocada. Tente entrar com a nova senha; se não funcionar, peça um novo link" |

## 5. Falhas, concorrência e segurança
| Tema | Garantia | Origem |
|---|---|---|
| Resposta neutra | 202 com a mesma mensagem e o mesmo tempo de caminho; nenhum indício de existência | **[PROPOSTA]** caminho de requisição sem banco (B) |
| Tempo | sem `sleep` fixo: a neutralidade vem do **mesmo trabalho** na requisição (validar, limitar, enfileirar). O custo do worker não aparece na resposta | **[PROPOSTA]** |
| Abuso e custo | limite por **IP** (novo) e por **e-mail** (existente), antes de enfileirar; fila com teto (`EMAIL_QUEUE_MAX`); workers fixos (`EMAIL_WORKERS`); chaves dos limitadores com teto (`max_keys`) | **[PROPOSTA]** + **[EXISTE]** |
| Limite por destinatário | o limite por e-mail também protege a caixa da vítima (bombardeio); conta pedidos para e-mails **inexistentes** do mesmo jeito | **[EXISTE]** |
| Falha depois do COMMIT | token emitido e válido até expirar, sem e-mail; nada é desfeito | **[EXISTE]** + **[PROPOSTA]** log de categoria |
| Segundo pedido invalida o primeiro | `issue_replacing_active` (bloqueio + índice parcial) | **[EXISTE]** |
| Mensagens fora de ordem | o e-mail mais antigo traz um token já invalidado → "link inválido ou substituído". O corpo informa o horário de expiração persistido e "use o e-mail mais recente" | **[EXISTE]** semântica + **[PROPOSTA]** texto |
| Token expirado, usado ou invalidado | `invalid_reset_token` (400), igual para os três, sem distinguir; pré-validação sem Argon2 | **[EXISTE]** |
| Redefinições concorrentes | `complete_reset` com bloqueio e revalidação; uma vence, a outra recebe 400 | **[EXISTE]** (testado com PostgreSQL) |
| Sessões | o reset revoga todas e incrementa `credential_version`; sem login automático | **[EXISTE]** |
| Logs | nunca token, link, senha, corpo, credenciais SMTP nem e-mail completo; só `user_id`, categoria do resultado (`sent`, `transport_timeout`, `transport_refused`, `queue_full`, `unknown_user`) e duração | **[PROPOSTA]** + `__repr__` existente |
| Erros SMTP | capturar e registrar só a **classe** da exceção (respostas do servidor podem conter o destinatário) | **[PROPOSTA]** |
| Origem do link | `PUBLIC_APP_ORIGIN` validada no startup (só a origem; `https` obrigatório fora de loopback; igual ao `PRAZOAI_APP_ORIGIN` do BFF, conferido em teste); **nunca** derivada de `Host` ou de cabeçalhos encaminhados | **[PROPOSTA]** |
| Fragmento | o token vai em `#TOKEN`, que não é enviado ao servidor; a página remove-o imediatamente e o mantém só em memória; nunca em `localStorage`, `sessionStorage`, cookie, query ou caminho | **[PROPOSTA]** (reaproveita o padrão de `invite-token.mjs`) |
| Caminho antigo `/redefinir-senha/[token]` | é removido. Como nenhum link real foi emitido nesse formato, não há compatibilidade a manter. Uma requisição antiga recebe página estática com `Referrer-Policy: no-referrer`, sem eco do token, sem chamadas e sem log do caminho | **[PROPOSTA]** |
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
| `EMAIL_QUEUE_MAX` / `EMAIL_WORKERS` | 100 / 1 | tetos de memória e trabalho |
| `AUTH_FORGOT_IP_MAX_REQUESTS` / `_WINDOW_SECONDS` | 10 / 900 | limite novo por IP |

**Segredos:** só por variáveis de ambiente ou gerenciador de segredos (futuro), nunca no
repositório, em `.env.example` com valores reais ou em artefatos. `hide_input_in_errors` (P3)
continua cobrindo os erros de validação. Produção segue bloqueada.

## 8. Plano de implementação (entregas pequenas, cada uma com auditoria)
| # | Entrega | Critérios de aceite |
|---|---|---|
| E1 | Configuração + `EmailTransport` + `SmtpTransport` + composer (backend, ainda sem usar no fluxo) | validação completa no startup (TLS, origem, remetente); testes unitários de cabeçalhos, TLS obrigatório e timeout; nenhuma mudança de comportamento com `disabled` |
| E2 | `RecoveryDispatcher` + caminho de requisição sem banco + limite por IP + `status` | mesmo caminho para conta existente e inexistente (teste estrutural); fila e workers limitados; falha de transporte só com log de categoria; garantias da P3 intactas (suítes atuais verdes) |
| E3 | Capturador SMTP local no CI + testes de integração do transporte e do fluxo com PostgreSQL | e-mail recebido no capturador com o link correto; falha e timeout do transporte; nenhum token em logs |
| E4 | Rotas BFF públicas (`status`, `forgot`, `reset`) | allowlist; CSRF e Origin; corpo exato; `no-store`; cookies intocados; resultado desconhecido sem repetição; testes de integração BFF × FastAPI |
| E5 | Telas integradas + remoção de `/redefinir-senha/[token]` + E2E | E2E: pedido → capturador → link → nova senha → senha antiga recusada → nova aceita → sessões anteriores revogadas; nenhum token em URL de requisição, storage ou logs |
| E6 | Documentação operacional e revisão de observabilidade | doc atualizado; roteiro de operação do transporte |

Cada entrega preserva:
- a imagem oficial do Playwright e as proteções dos bancos descartáveis;
- os limites de taxa e a ausência de retries;
- a validação completa na árvore final, com artefatos reproduzíveis.

## 9. Matriz requisito → teste (**planejado**, salvo indicação)
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
| Fila cheia e reinício | descarte com log; resposta neutra | planejado (E2) |
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
| D-E2 | Modo de entrega | B (segundo plano em memória, limitado); D como evolução durável; C rejeitado sem aprovação de segurança |
| D-E3 | Repetição do envio | nenhuma automática (opcional: 1 só para falha antes da conexão) |
| D-E4 | Captura local | transporte em memória (unitário) + capturador SMTP em contêiner (integração/E2E) |
| D-E5 | Pedido com transporte desabilitado | 503 `password_recovery_unavailable` + `status` (alternativa: 202 neutro) |
| D-E6 | Caminho antigo `/redefinir-senha/[token]` | remover; página estática sem eco e com `no-referrer` |
| D-E7 | Origem do link | `PUBLIC_APP_ORIGIN` no backend, igual à do BFF, validada |

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
