# 04 — Contratos de API Iniciais

> Etapa 1. Contratos planejados sob a base versionada **`/api/v1`**. **Apenas
> `GET /api/v1/health` está implementado** nesta etapa; o restante é especificação
> para as próximas etapas (não implementar agora).

## Convenções
- Base canônica: `/api/v1` (prefixo `/api` + versão `/v1`). JSON em UTF-8.
- Alias legado: `/api/health` (compatibilidade; o contrato oficial é `/api/v1/health`).
- Erros: `{ "error": { "code": string, "message": string, "details?": any } }` (sem stack trace).
- Autenticação (futura): `Authorization: Bearer <token>`.
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

## /auth (futuro)
- `POST /api/v1/auth/login` — body `{ email, password }` → 200 `{ accessToken, refreshToken, user }`; 401 credenciais inválidas.
- `POST /api/v1/auth/refresh` — body `{ refreshToken }` → 200 `{ accessToken }`; 401.
- `POST /api/v1/auth/logout` — auth → 204.
- `GET /api/v1/auth/me` — auth → 200 `{ user, membership? }`; 401.

## /users (futuro)
- `GET /api/v1/users/me` — auth → 200 perfil.
- `PATCH /api/v1/users/me` — auth; body `{ name?, preferences? }` → 200. (e-mail não editável)
- `GET /api/v1/users/:id` — auth + mesma organização → 200; 403/404.

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
422 Unprocessable Entity (validação de DTO) · 500 Internal Error.
