# 04 — Contratos de API Iniciais

> Contratos sob a base versionada **`/api/v1`**.
> **Implementados:** `GET /api/v1/health` (Etapa 1) e os grupos **`/auth`** e **`/users/me`**
> (Etapa 2 — armazenamento em memória, ver `06-etapa-2-autenticacao.md`).
> e, na Etapa 3, **escritórios, equipe, convites e solicitações** (`07-etapa-3-escritorios-rbac.md`).
> e, na Etapa 4, **prazos, comentários, histórico, calendário e transferência** (`08-etapa-4-prazos.md`).
> e, na Etapa 5, **intimações (metadados e revisão humana) e notificações internas** (`09-…`).
> **Planejados:** armazenamento de arquivos, processamento, anexos, auditoria e IA.

## Convenções
- Base canônica: `/api/v1` (prefixo `/api` + versão `/v1`). JSON em UTF-8.
- Alias legado: `/api/health` (compatibilidade; o contrato oficial é `/api/v1/health`).
- Erros: `{ "error": { "code": string, "message": string, "details?": any } }` (sem stack trace).
- Autenticação: `Authorization: Bearer <accessToken>` (Etapa 2). Corpos JSON em camelCase;
  campos não previstos → 422.
- Permissões referenciam o RBAC do domínio (03): `deadline.*`, `team.manage`, `office.manage`
  (matriz de delegação implementada na Etapa 3).
- Paginação (futura): `?page`, `?perPage`; busca `?q`; filtros conforme recurso.

---

## /health
### GET /api/v1/health — IMPLEMENTADO (alias legado: GET /api/health)
- Objetivo: verificação de saúde.
- Auth: não. Permissão: nenhuma.
- Resposta 200: `{ "status": "ok", "service": "prazoai-backend" }`.
- Erros: 500 `internal_error` (genérico).

---

## /auth — IMPLEMENTADO (Etapa 2, em memória)
Usuário público (`PublicUser`): `{ id, name, email, createdAt }` — nunca senha/hash.

- `POST /api/v1/auth/register` — body `{ name, email, password }` → **201** `PublicUser`.
  Não autentica. 409 `email_already_registered`; 422 dados inválidos ou campos extras
  (`role`, `permissions`, `officeId`, `id`...); 429 `rate_limited` (por IP).
- `POST /api/v1/auth/login` — body `{ email, password }` → **200**
  `{ accessToken, refreshToken, tokenType: "Bearer", expiresIn, user }`.
  401 `invalid_credentials` (genérico); 429 `rate_limited` (+ `Retry-After`).
- `POST /api/v1/auth/refresh` — body `{ refreshToken }` → **200**
  `{ accessToken, refreshToken, tokenType, expiresIn }`. **Evolução do contrato:** devolve um
  novo `refreshToken` (rotação a cada uso); o anterior deixa de valer e sua reutilização revoga
  a sessão inteira. 401 `invalid_refresh_token`. Cada sessão aceita no máximo
  `AUTH_MAX_REFRESH_ROTATIONS_PER_SESSION` rotações (padrão 1000); o refresh seguinte encerra
  a sessão com 401 `session_rotation_limit_reached` (novo login obrigatório).
- `POST /api/v1/auth/logout` — auth → **204** sem corpo; revoga a sessão atual (access e
  refresh deixam de valer imediatamente). 401 sem token.
- `GET /api/v1/auth/me` — auth → **200** `{ user }` (sem `membership`: escritórios na próxima
  etapa); 401.
- `POST /api/v1/auth/forgot-password` — body `{ email }` → **202**
  `{ message }` idêntico para e-mail existente ou não; no máximo um token ativo por usuário
  (novo pedido invalida o anterior); 429 `rate_limited`. Nenhum token volta
  pela API (entrega real depende da etapa de e-mail).
- `POST /api/v1/auth/reset-password` — body `{ token, newPassword }` → **204**; revoga todas
  as sessões e tokens de recuperação pendentes; não autentica. 400 `invalid_reset_token`; 422;
  429 `rate_limited` (por IP).

Erros de autenticação: 401 `not_authenticated` (sem token) ou `invalid_token` (inválido,
adulterado, expirado, finalidade incorreta ou sessão revogada), com `WWW-Authenticate: Bearer`.

## /users
- `GET /api/v1/users/me` — **IMPLEMENTADO** — auth → 200 `PublicUser`.
- `PATCH /api/v1/users/me` — **IMPLEMENTADO** — auth; body `{ name }` → 200 `PublicUser`.
  E-mail, senha, id, permissões, escritório e `preferences` → 422 (preferências: planejado).
- `GET /api/v1/users/:id` — planejado — auth + mesma organização → 200; 403/404.

## /offices, /memberships, /invitations, /join-requests — IMPLEMENTADO (Etapa 3, em memória)
Contratos completos, matriz de autorização e códigos de erro em
`07-etapa-3-escritorios-rbac.md`. Resumo das mudanças em relação ao planejado:
- `POST /api/v1/offices` → 201 `{ office, membership }` (cria o vínculo administrativo junto);
  409 `already_in_office`.
- `GET /api/v1/memberships/me` → `{ office, membership }` (nulos se sem vínculo).
- `GET|PATCH /api/v1/offices/:id` (membro / `office.manage`); externo → 404.
- Equipe: `GET /api/v1/offices/:id/members` (projeção pública ou administrativa),
  `PATCH /api/v1/offices/:id/members/:userId` (matriz de delegação),
  `POST .../members/:userId/promote`. **Substitui** `PATCH /memberships/:userId`.
- Remoção: `POST /api/v1/offices/:id/members/:userId/remove` `{ reassignTo? }` e saída
  `POST /api/v1/offices/:id/leave` `{ successorUserId?, reassignTo? }` — **substituem**
  `DELETE` com corpo; **desde a Etapa 4** reatribuem os prazos em aberto (`reassignTo`
  obrigatório se houver) numa única transação.
- Convites: `POST /api/v1/offices/:id/invitations` → 201 com `token` (única vez);
  `GET .../invitations`; `POST .../invitations/:invitationId/revoke`.
  **Token no corpo:** `POST /api/v1/invitations/lookup` `{ token }` → `{ state, officeName? }`
  e `POST /api/v1/invitations/accept` `{ token }` **substituem** `GET /invitations/:token` e
  `POST /invitations/:token/accept` (token fora de caminhos/logs).
- Código de ingresso: `GET /api/v1/offices/:id/join-code`, `POST .../join-code/rotate`.
- Solicitações (novas): `POST /api/v1/join-requests` `{ joinCode }`, `GET /api/v1/join-requests/me`,
  `POST /api/v1/join-requests/:id/cancel`, `GET /api/v1/offices/:id/join-requests?status=`,
  `POST /api/v1/offices/:id/join-requests/:id/approve|reject`.

## /roles (futuro)
- `GET /api/v1/roles` — auth → 200 catálogo de permissões conhecidas.
- (Cargos são rótulos + conjunto de permissões no Membership; CRUD via /memberships.)

## /deadlines e /calendar — IMPLEMENTADO (Etapa 4, em memória)
Contratos completos em `08-etapa-4-prazos.md`. Mudanças em relação ao planejado:
- `GET /api/v1/deadlines` exige `scope=personal|office` e aceita também `responsibleId`,
  `dueFrom`, `dueTo`, `sort`, `dir`; resposta paginada `{ items, page, perPage, total, pageCount }`.
- `POST /api/v1/deadlines` → 201 (`scope` no corpo; `officeId` vem do vínculo atual).
- `PATCH`, `POST .../status` e `POST .../transfer` exigem `version` (409 `version_conflict`).
- `POST /api/v1/deadlines/:id/transfer` `{ version, officeId, confirmSharing: true, shareLinkedIntimation? }` →
  `{ deadline, notice }` (Etapa 5: consentimentos booleanos estritos; intimação vinculada exige
  `shareLinkedIntimation: true`).
- Comentários: `GET|POST /api/v1/deadlines/:id/comments`; histórico: `GET .../history`.
- `GET /api/v1/calendar` com `scope`, `year`, `month`, `status?`, `page`, `perPage` (até 500) e
  `hasNextPage`/`nextPage`.
- Sem exclusão de prazos (cancelamento).

## /intimations e /notifications — IMPLEMENTADO (Etapa 5, em memória)
Contratos completos em `09-etapa-5-intimacoes-notificacoes.md`. Mudanças em relação ao planejado:
- `POST /api/v1/intimations` registra **metadados declarados** (sem upload; `file.storage = "not_stored"`).
- Não há processamento: `processing.status = "not_available"`; `retry` responde 409 `processing_unavailable`.
- `PATCH /api/v1/intimations/:id` (rascunho) e `POST .../confirm` substituem `.../review`; a confirmação
  exige `version` e todos os dados finais; 201 na primeira, 200 em repetição sem efeito.
- `POST .../discard` (descarte lógico) substitui a remoção definitiva.
- Notificações individuais: `GET /api/v1/notifications?scope=`, `.../unread-count`, `.../:id/read`
  e `.../read-all` (substitui `PATCH /notifications/:id`).

## /attachments (futuro)
- `POST /api/v1/deadlines/:id/attachments` — auth + permissão → 201 (storage de objetos no futuro).
- `DELETE /api/v1/attachments/:id` — auth + permissão → 204.

## /audit (futuro)
- `GET /api/v1/audit` — auth + `office.manage` → 200 (trilha; sem dados sensíveis).

## /ai (futuro)
- `POST /api/v1/ai/intimations/:id/analyze` — auth + acesso → 202 (análise assíncrona; não substitui revisão humana).

---

### Códigos HTTP usados
200 OK · 201 Created · 202 Accepted · 204 No Content · 400 Bad Request ·
401 Unauthorized · 403 Forbidden · 404 Not Found · 409 Conflict · 410 Gone ·
422 Unprocessable Entity (validação de DTO) · 429 Too Many Requests · 500 Internal Error.
