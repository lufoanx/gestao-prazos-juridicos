# 04 — Contratos de API Iniciais

> Contratos sob a base versionada **`/api/v1`**.
> **Implementados:** `GET /api/v1/health` (Etapa 1) e os grupos **`/auth`** e **`/users/me`**
> (Etapa 2 — armazenamento em memória, ver `06-etapa-2-autenticacao.md`).
> **Planejados:** todos os demais grupos (escritórios, prazos, intimações etc.).

## Convenções
- Base canônica: `/api/v1` (prefixo `/api` + versão `/v1`). JSON em UTF-8.
- Alias legado: `/api/health` (compatibilidade; o contrato oficial é `/api/v1/health`).
- Erros: `{ "error": { "code": string, "message": string, "details?": any } }` (sem stack trace).
- Autenticação: `Authorization: Bearer <accessToken>` (Etapa 2). Corpos JSON em camelCase;
  campos não previstos → 422.
- Permissões referenciam o RBAC do domínio (03): `deadline.*`, `team.manage`, `office.manage`.
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
  a sessão inteira. 401 `invalid_refresh_token`.
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

## /offices (futuro)
- `POST /api/v1/offices` — auth; body `{ name }` → 201 (regra: escritório único). Erros: 409 já possui escritório.
- `GET /api/v1/offices/:id` — auth + membro → 200; 403.
- `PATCH /api/v1/offices/:id` — auth + `office.manage` → 200; 403.

## /memberships (futuro)
- `GET /api/v1/offices/:id/memberships` — auth + membro (`team.manage` p/ detalhes) → 200.
- `PATCH /api/v1/offices/:id/memberships/:userId` — auth + `team.manage`; body `{ roleLabel?, permissions?, visibility?, practiceAreas? }` → 200. Regras: sem auto-escalada; preservar último admin.
- `DELETE /api/v1/offices/:id/memberships/:userId` — auth + `team.manage`; body `{ reassignTo? }` → 200. Regra: reatribuir prazos em aberto; não remover último admin. Erros: 409 `needs-reassign`.

## /invitations (futuro)
- `POST /api/v1/offices/:id/invitations` — auth + `team.manage`; body `{ roleLabel? }` → 201 `{ token, expiresAt }`.
- `POST /api/v1/invitations/:token/accept` — auth → 200 (regra escritório único). Erros: 410 expirado/usado/revogado, 404 inválido.
- `DELETE /api/v1/invitations/:id` — auth + `team.manage` → 204 (revoga).
- `GET /api/v1/invitations/:token` — público → 200 `{ state }` (valid|expired|used|revoked|invalid).

## /roles (futuro)
- `GET /api/v1/roles` — auth → 200 catálogo de permissões conhecidas.
- (Cargos são rótulos + conjunto de permissões no Membership; CRUD via /memberships.)

## /deadlines (futuro)
- `GET /api/v1/deadlines` — auth; query `scope`, `q`, `status`, `urgency`, `area`, `page`, `perPage` → 200 (isolamento + visibilidade). 
- `POST /api/v1/deadlines` — auth + `deadline.create` → 201.
- `GET /api/v1/deadlines/:id` — auth + leitura permitida → 200; 403/404.
- `PATCH /api/v1/deadlines/:id` — auth + `deadline.edit` → 200.
- `POST /api/v1/deadlines/:id/status` — auth + `deadline.complete`; body `{ status }` → 200 (concluir/cancelar/reabrir).
- `POST /api/v1/deadlines/:id/transfer` — auth + `deadline.transfer`; body `{ officeId }` → 200 (preserva registro; sem duplicar).
- `POST /api/v1/deadlines/:id/comments` — auth + `deadline.create` → 201.
- `GET /api/v1/deadlines/:id/history` — auth + leitura → 200.

## /calendar (futuro)
- `GET /api/v1/calendar` — auth; query `year`, `month`, `scope` → 200 (vencimentos do ambiente).

## /intimations (futuro)
- `GET /api/v1/intimations` — auth; query `scope`, `status`, `q` → 200 (isolamento + permissão + visibilidade; autor vê o próprio pendente).
- `POST /api/v1/intimations` — auth + `deadline.create` (upload PDF) → 201 `{ id, status: "processing" }`.
- `POST /api/v1/intimations/:id/retry` — auth + acesso → 200.
- `DELETE /api/v1/intimations/:id` — auth + acesso (não `reviewed`) → 204.
- `POST /api/v1/intimations/:id/review` — auth + `deadline.create`; body com dados revisados → 201 `{ deadlineId }` (um único; sem duplicar).

## /notifications (futuro)
- `GET /api/v1/notifications` — auth; query `scope`, `filter` → 200.
- `POST /api/v1/notifications/:id/read` — auth → 204.
- `POST /api/v1/notifications/read-all` — auth; body `{ scope }` → 204.

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
