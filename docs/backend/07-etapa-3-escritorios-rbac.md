# 07 — Etapa 3: Escritórios, equipe, permissões e isolamento

> **Atualização Etapa 4:** remoção e saída deixaram de ser bloqueadas — agora reatribuem os
> prazos em aberto com a porta real (`08-etapa-4-prazos.md`). As transações passaram a usar
> escritas preparadas com rollback real.
>
> **Estado:** implementado no backend (FastAPI) com armazenamento **em memória**, sem banco,
> sem integração com as telas. O frontend continua demonstrativo.
> Distinção usada neste documento: **implementado** (funciona e tem testes), **testado com
> adaptador** (regras verificadas com dublês, sem o módulo real) e **planejado**.

## 1. Escopo

| Item | Estado |
|---|---|
| Criar escritório (com vínculo administrativo atômico) | implementado |
| Consultar escritório e o próprio vínculo | implementado |
| Editar dados do escritório (`office.manage`) | implementado |
| Listar equipe com projeção por solicitante | implementado |
| Editar cargo, áreas, visibilidade e permissões (matriz abaixo) | implementado |
| Promover sucessor | implementado |
| Código de ingresso (consultar, girar) | implementado |
| Convites (criar, listar, revogar, consultar, aceitar) | implementado |
| Solicitações (criar, listar próprias, cancelar, listar/aprovar/rejeitar) | implementado |
| Remover membro | implementado na Etapa 4 (reatribuição real; ver doc 08) |
| Sair do escritório (inclusive com sucessor) | implementado na Etapa 4 (reatribuição real; ver doc 08) |
| Reatribuição real de prazos | implementado na Etapa 4 |

Fora do escopo: CRUD de prazos/intimações, arquivos, IA, e-mail real, PostgreSQL/ORM,
integração com as telas, mudanças visuais.

## 2. Matriz de autorização (aprovada)

Atores: **externo** (sem vínculo com o escritório), **membro** (sem `team.manage`),
**gestor** (`team.manage` sem `office.manage`) e **administrador** (`office.manage`).
A autoridade é o vínculo ATUAL, lido no servidor **dentro da transação** de cada operação.

| Operação | Externo | Membro | Gestor | Admin |
|---|---|---|---|---|
| Criar escritório (só sem vínculo ativo) | ✔ | — | — | — |
| Ver escritório / próprio vínculo | 404 | ✔ | ✔ | ✔ |
| Editar dados do escritório | 404 | 403 | 403 | ✔ |
| Listar membros | 404 | projeção pública | projeção administrativa | projeção administrativa |
| Editar cargo/áreas/visibilidade de membro comum | 404 | 403 | ✔ | ✔ |
| Editar outro gestor ou administrador | 404 | 403 | 403 | ✔ |
| Conceder/retirar `deadline.*` | 404 | 403 | ✔ só o que possui; alvo comum | ✔ só o que possui |
| Conceder visibilidade `all` | 404 | 403 | ✔ só se ele tem `all` | ✔ só se ele tem `all` |
| Conceder/retirar `team.manage` ou `office.manage` | 404 | 403 | 403 | ✔ (≥ 1 admin) |
| Promover sucessor | 404 | 403 | 403 | ✔ |
| Remover membro comum | 404 | 403 | bloqueado* | bloqueado* |
| Remover gestor/admin | 404 | 403 | 403 | bloqueado* |
| Convites: **criar** | 404 | 403 | ✔ só com o conjunto de ingresso† | ✔ só com o conjunto de ingresso† |
| Convites: listar/revogar | 404 | 403 | ✔ | ✔ |
| Código de ingresso: ver/girar | 404 | 403 | ✔ | ✔ |
| Solicitações: listar/rejeitar | 404 | 403 | ✔ | ✔ |
| Solicitações: **aprovar** | 404 | 403 | ✔ só com o conjunto de ingresso† | ✔ só com o conjunto de ingresso† |
| Sair | — | bloqueado* | bloqueado* | bloqueado* (último admin indica sucessor) |

\* Até a Etapa 3: 409 `responsibility_module_unavailable`. Desde a Etapa 4: reatribuição real
dos prazos em aberto (`reassignTo`), numa única transação (doc 08).

† **Autorização para conceder o conjunto de ingresso.** Emitir convite ou aprovar
solicitação concede ao novo membro `MEMBER_PERMS` (`deadline.read`, `deadline.create`,
`deadline.edit`, `deadline.complete`) com `visibility=assigned`. Pela mesma regra de
delegação do `PATCH` de membros, o ator precisa de `team.manage` **e** de todas essas
permissões (visibilidade `assigned` não exige `all`). Sem elas: 403
`delegation_not_allowed`, sem efeito (convite não emitido, solicitação continua pendente,
nenhum vínculo). O conjunto do novo membro **nunca** é reduzido em silêncio. A verificação
ocorre na mesma transação da emissão/aprovação. Rejeitar não concede nada e exige só
`team.manage`. Um convite emitido legitimamente continua válido se o emissor perder
permissões depois (decisão aprovada): a aceitação não reavalia o emissor.

**Regras e invariantes** (`app/policies/org.py`, funções puras):
- `office.manage` exige `team.manage`; conjunto não vazio; permissões desconhecidas ou
  repetidas → 422 (nunca descartadas).
- Privilégios administrativos só são concedidos/retirados por administrador (inclusive o
  próprio `team.manage` de um gestor).
- Gestor sem `office.manage` não altera outros gestores ou administradores.
- Delegação limitada ao que o ator possui (permissões `deadline.*` e visibilidade `all`).
- Ninguém amplia a própria visibilidade ou permissões; reduzir o próprio acesso é permitido
  (salvo privilégio administrativo de gestor e último admin).
- O escritório nunca fica sem administrador.
- Cargo (`roleLabel`) e `createdBy` não concedem poderes; não há exceção por "dono".
- Ingresso (convite/aprovação) exige autoridade para conceder o conjunto de ingresso
  (`can_grant_entry`): `team.manage` + todo `MEMBER_PERMS`.

**Respostas:** recurso de outro escritório ou inexistente → **404 `not_found`** (mesmo
corpo); **403 `forbidden`** só dentro do próprio escritório quando falta permissão.

## 3. Diferenças em relação ao protótipo (endurecimentos)

| Protótipo (`org-ops.mjs`) | Backend |
|---|---|
| Só impede autoescalada | Também bloqueia escalada indireta: só admin mexe em privilégios administrativos; delegação limitada ao que o ator tem |
| Qualquer `team.manage` convida/aprova | Convidar/aprovar exige possuir todo o conjunto de ingresso |
| `team.manage` concede `office.manage` e altera admins | Exige `office.manage` |
| Visibilidade sem restrição de delegação | Só concede `all` quem tem `all` |
| Entradas inválidas descartadas em silêncio | 422 |
| Código de ingresso = ID do escritório | Código aleatório separado, rotacionável |
| Token do convite guardado em claro e na URL | Só hash; token no corpo da requisição |
| Aprovação com conflito marca `rejected` | Marca `cancelled` e responde 409 |
| `JoinRequest` copia nome e e-mail | Só referencia o usuário |
| Saída sem verificar prazos | Bloqueada até a Etapa 4 |
| `office.manage` sem `team.manage` possível | Invariante: `office.manage ⇒ team.manage` |

**Divergência de permissões de ingresso:** o backend usa `MEMBER_PERMS` de
`frontend/src/lib/org-ops.mjs` (`deadline.read`, `deadline.create`, `deadline.edit`,
`deadline.complete`), conforme decisão. `MEMBER_PERMISSIONS` de `session.mjs` não inclui
`deadline.edit`. O frontend não foi alterado nesta etapa.

## 4. Contratos (base `/api/v1`, JSON camelCase, campos extras → 422)

| Método e rota | Auth | Resposta |
|---|---|---|
| `POST /offices` `{name, roleLabel?, practiceAreas?}` | sim | 201 `{office, membership}` |
| `GET /memberships/me` | sim | 200 `{office, membership}` (nulos se sem vínculo) |
| `GET /offices/{officeId}` | sim | 200 `{id, name, createdAt}` |
| `PATCH /offices/{officeId}` `{name}` | sim | 200 |
| `GET /offices/{officeId}/members` | sim | 200 `{projection, members}` |
| `PATCH /offices/{officeId}/members/{userId}` `{roleLabel?, practiceAreas?, visibility?, permissions?}` | sim | 200 |
| `POST /offices/{officeId}/members/{userId}/promote` | sim | 200 |
| `POST /offices/{officeId}/members/{userId}/remove` `{reassignTo?}` | sim | 204 — **bloqueado (409)** |
| `POST /offices/{officeId}/leave` `{successorUserId?, reassignTo?}` | sim | 204 — **bloqueado (409)** |
| `GET /offices/{officeId}/join-code` / `POST .../join-code/rotate` | sim | 200 `{joinCode}` |
| `POST /offices/{officeId}/invitations` `{roleLabel?}` | sim | 201 `{id, roleLabel, state, createdAt, expiresAt, closedAt, token}` |
| `GET /offices/{officeId}/invitations` | sim | 200 lista (sem token) |
| `POST /offices/{officeId}/invitations/{id}/revoke` | sim | 200 |
| `POST /invitations/lookup` `{token}` | não | 200 `{state, officeName?}` |
| `POST /invitations/accept` `{token}` | sim | 200 `{office, membership}` |
| `POST /join-requests` `{joinCode}` | sim | 201 |
| `GET /join-requests/me` | sim | 200 |
| `POST /join-requests/{id}/cancel` | sim | 200 |
| `GET /offices/{officeId}/join-requests?status=` | sim | 200 |
| `POST /offices/{officeId}/join-requests/{id}/approve` · `/reject` | sim | 200 |

Projeções: **pública** `{userId, name, roleLabel, practiceAreas}`; **administrativa**
acrescenta `{email, permissions, visibility, joinedAt}`. Nunca preferências, sessões,
hashes ou tokens. O próprio vínculo (`membership`) inclui as permissões do solicitante.

Códigos de erro: `not_found` 404 · `forbidden` 403 · `self_escalation_forbidden` 403 ·
`delegation_not_allowed` 403 · `invalid_permission_set` 422 · `last_admin` 409 ·
`already_in_office` 409 · `invalid_successor` / `successor_required` 409 ·
`cannot_remove_self` 409 · `reassign_required` 409 · `responsibility_module_unavailable` 409 ·
`invitation_invalid` 404 · `invitation_expired|used|revoked` 410 · `invitation_not_pending` 409 ·
`join_code_invalid` 404 · `request_already_pending` / `request_not_pending` /
`pending_limit_reached` 409 · `join_code_unavailable` 503 · `rate_limited` 429.

### Exemplos
```bash
H='Authorization: Bearer <accessToken>'
curl -X POST localhost:8000/api/v1/offices -H "$H" -H 'content-type: application/json' \
  -d '{"name":"Silva Advogados","roleLabel":"Sócia","practiceAreas":["Cível"]}'
curl -X POST localhost:8000/api/v1/offices/<officeId>/invitations -H "$H" \
  -H 'content-type: application/json' -d '{"roleLabel":"Advogado"}'      # token só aqui
curl -X POST localhost:8000/api/v1/invitations/lookup -H 'content-type: application/json' \
  -d '{"token":"<token>"}'
curl -X POST localhost:8000/api/v1/invitations/accept -H "$H" -H 'content-type: application/json' \
  -d '{"token":"<token>"}'
curl -X PATCH localhost:8000/api/v1/offices/<officeId>/members/<userId> -H "$H" \
  -H 'content-type: application/json' -d '{"permissions":["deadline.read"],"visibility":"assigned"}'
```

## 5. Convites e código de ingresso
- **Convite = credencial portadora:** não é ligado a e-mail. Quem receber o link pode usá-lo
  se estiver autenticado e sem escritório. Uso único, validade padrão de 7 dias
  (`ORG_INVITE_TTL_SECONDS`), revogável; só o SHA-256 é guardado; o token em claro aparece
  apenas na resposta de criação (nunca em listagens ou logs). Dá sempre `MEMBER_PERMS` com
  `visibility=assigned`; o gestor define só o cargo. Convites já emitidos continuam válidos
  se o gestor que os criou perder a permissão (podem ser revogados por outro gestor).
- **Interface futura:** o link deverá levar o token no fragmento (`#token`), nunca em caminho
  ou query, para que não chegue ao servidor do frontend. Não implementado agora.
- **Código de ingresso:** 10 caracteres Crockford base32 (sem I, L, O, U; ≈ 50 bits),
  gerado com `secrets`, único (colisão → nova tentativa; persistente → 503 sem efeito),
  separado do ID. Só permite **solicitar**; nunca concede vínculo. Girar invalida o anterior.
  Não há diretório público de escritórios ou usuários.

## 6. Solicitações
Estados `pending → approved | rejected | cancelled`. O cliente só dispara transições:
criar, cancelar a própria pendência, aprovar e rejeitar (gestão). Uma pendência por
(pessoa, escritório). Entrar em qualquer escritório (criação, convite ou aprovação) cancela
atomicamente as demais pendências da pessoa. **Transição de conflito:** se, na aprovação, a
pessoa já tiver vínculo em outro escritório, a solicitação passa a `cancelled` (não
`rejected`, `decidedBy` vazio) e a resposta é 409 `already_in_office`. A aprovação cria
vínculo com cargo "Membro", `MEMBER_PERMS` e `assigned`.

## 7. Garantias de concorrência
Toda operação protegida roda em `OrgRepository.transaction(clock)`: em memória, um `RLock`
por instância durante o bloco inteiro; **o relógio é lido depois de obtido o lock**
(`tx.now`) e esse mesmo instante é usado em todas as validações temporais (expiração de
convite, teto de pendentes, limpeza) e carimbos (criação, aceitação, revogação, decisão)
da transação. O serviço lê o vínculo do ator e do alvo, aplica as políticas e só então
escreve. Não há checagem fora da transação (nem no JWT). Garantias
testadas com `Barrier`/`Event`:
- criação concorrente pelo mesmo usuário → um escritório;
- ingresso concorrente em dois escritórios → um vínculo; o outro convite não é gasto;
- aceitação concorrente do mesmo convite → uma entrada;
- aceitação × revogação, aprovação × aceitação de convite → estados coerentes;
- rebaixamentos concorrentes dos dois últimos admins → sempre ≥ 1 admin;
- alteração administrativa × perda de autoridade → a alteração tardia recebe 403;
- aprovações/rejeição concorrentes da mesma solicitação → uma decisão;
- perda de permissão × emissão de convite/aprovação → 403 sem efeito;
- convite que expira **durante a espera pelo lock** (inclusive no instante exato) → 410,
  sem consumo e sem vínculo; consulta, revogação, teto de pendentes, carimbos e limpeza
  também usam o instante pós-lock.
Escritório único também é defendido no próprio repositório (`put_membership`).
PostgreSQL: mesma transação com `SELECT ... FOR UPDATE` e restrições únicas (ver
`app/repositories/org.py`).

## 8. Limites e retenção (configuráveis)
| Variável | Padrão | Justificativa |
|---|---|---|
| `ORG_INVITE_TTL_SECONDS` | 7 dias | decisão aprovada |
| `ORG_INVITE_CREATE_MAX` / janela | 20 / 1 h por gestor | uso normal de escritório pequeno |
| `ORG_INVITE_LOOKUP_MAX` / janela | 30 / 15 min por IP | consulta pública; dificulta tentativa de tokens |
| `ORG_INVITE_ACCEPT_MAX` / janela | 10 / 15 min por IP e por usuário | idem |
| `ORG_JOIN_REQUEST_MAX` / janela | 10 / 1 h por IP e por usuário | conta tentativas inválidas: impede enumeração de códigos |
| `ORG_MAX_PENDING_INVITES_PER_OFFICE` | 50 | teto de crescimento |
| `ORG_MAX_PENDING_REQUESTS_PER_OFFICE` | 200 | teto de crescimento |
| `ORG_MAX_PENDING_REQUESTS_PER_USER` | 5 | evita spam de solicitações |
| `ORG_CLOSED_RETENTION_SECONDS` | 30 dias | histórico curto de convites/solicitações encerrados; depois removidos |
| `OFFICES_ENABLED` | acompanha `AUTH_ENABLED` | módulo depende da autenticação |

Limitadores reutilizam o teto de chaves de `AUTH_RATE_LIMIT_MAX_KEYS` (balde de transbordo).
Vínculos e escritórios não expiram (crescimento limitado por usuários: um vínculo por pessoa).

**Production:** com `OFFICES_ENABLED` efetivo, `create_app` falha em `ENVIRONMENT=production`
(`InMemoryOrgBlockedError`), **inclusive se `AUTH_ENABLED=false` e `OFFICES_ENABLED=true`**.
`OFFICES_ENABLED=true` com `AUTH_ENABLED=false` é erro de configuração.

## 9. Integração com a Etapa 4
`app/services/responsibility_port.py`:
- `count_open(office_id, user_id)` e `reassign_open(office_id, from, to)` (atômica);
- chamadas dentro da transação do escritório, depois de autorização/invariantes e antes das
  escritas de vínculo; com banco, na MESMA transação; em memória, ordem de locks
  escritórios → prazos;
- hoje: `UnavailableResponsibilityPort` → 409 `responsibility_module_unavailable`, sem efeito.
Testes em `test_org_responsibilities.py` usam um **adaptador controlado** (não é integração).
Também caberá à Etapa 4 aplicar `deadline.*` e `visibility` às consultas de prazos.

## 10. Testes
`test_org_policies.py` (matriz pura), `test_org_offices_http.py`, `test_org_team_http.py`,
`test_org_invitations_http.py`, `test_org_join_requests_http.py`, `test_org_concurrency.py`,
`test_org_responsibilities.py` (adaptador controlado), `test_org_retention.py` e
`test_org_entry_and_time.py` (delegação no ingresso e horário pós-lock).
Fixture `org` em `tests/org_utils.py`; usa Argon2id real com parâmetros mínimos para
acelerar (a autenticação não é o objeto desses testes; os testes da Etapa 2 seguem com os
parâmetros padrão).

## 11. Limitações
- Armazenamento em memória: perda ao reiniciar, um worker, bloqueado em production.
- Remoção e saída indisponíveis até a Etapa 4.
- Limites de taxa por processo; IP visto pelo servidor.
- Falha inesperada do futuro adaptador de prazos vira 500 genérico (sem efeito parcial).
- Não há auditoria persistente das ações administrativas (apenas logs sem dados sensíveis).
