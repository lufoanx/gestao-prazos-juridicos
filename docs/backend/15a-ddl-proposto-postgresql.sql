-- =====================================================================================
-- PrazoAI — DDL PROPOSTO (rascunho de projeto técnico, NÃO é migration).
-- Validado num PostgreSQL 16 descartável durante a análise (ver doc 15, §11).
-- A implementação real virá como migrations Alembic, após aprovação.
-- Convenções:
--   * IDs: uuid (a API continua expondo o hex de 32 caracteres; conversão no repositório);
--   * instantes: timestamptz (UTC); datas civis: date; horário de agenda: time (sem fuso);
--   * enumerações: text + CHECK (mais simples de evoluir que tipos ENUM);
--   * "escopo": kind + owner_id/office_id, com coluna gerada scope_key para FKs compostas.
-- =====================================================================================

-- ------------------------------------------------------------------ identidade e sessões
CREATE TABLE users (
  id                  uuid PRIMARY KEY,
  name                text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  email               text NOT NULL CHECK (email = lower(email) AND char_length(email) <= 254),
  password_hash       text NOT NULL,                      -- Argon2id
  credential_version  integer NOT NULL DEFAULT 0 CHECK (credential_version >= 0),
  created_at          timestamptz NOT NULL,
  CONSTRAINT users_email_key UNIQUE (email)              -- unicidade de e-mail (normalizado)
);

CREATE TABLE auth_sessions (                             -- família de sessão (um login)
  id                    uuid PRIMARY KEY,
  user_id               uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at            timestamptz NOT NULL,
  expires_at            timestamptz NOT NULL,             -- vida máxima absoluta
  current_refresh_hash  text NOT NULL UNIQUE CHECK (char_length(current_refresh_hash) = 64),
  credential_version    integer NOT NULL,
  rotation_count        integer NOT NULL DEFAULT 0 CHECK (rotation_count >= 0),
  revoked_at            timestamptz,
  CHECK (expires_at > created_at)
);
CREATE INDEX auth_sessions_user_idx ON auth_sessions (user_id, created_at);
CREATE INDEX auth_sessions_expires_idx ON auth_sessions (expires_at);

CREATE TABLE auth_used_refresh_hashes (                  -- histórico de rotação (detecção de reutilização)
  refresh_hash  text PRIMARY KEY CHECK (char_length(refresh_hash) = 64),
  session_id    uuid NOT NULL REFERENCES auth_sessions(id) ON DELETE CASCADE,
  used_at       timestamptz NOT NULL
);
CREATE INDEX auth_used_refresh_session_idx ON auth_used_refresh_hashes (session_id);

CREATE TABLE password_reset_tokens (
  token_hash      text PRIMARY KEY CHECK (char_length(token_hash) = 64),  -- SHA-256; nunca o token
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at      timestamptz NOT NULL,
  expires_at      timestamptz NOT NULL,
  used_at         timestamptz,
  invalidated_at  timestamptz
);
-- No máximo UM token ativo (não usado e não invalidado) por usuário. A expiração por tempo
-- não entra no predicado (índices parciais não podem depender de now()); a emissão invalida o anterior.
CREATE UNIQUE INDEX password_reset_one_active_per_user
  ON password_reset_tokens (user_id) WHERE used_at IS NULL AND invalidated_at IS NULL;

-- ------------------------------------------------------------------ escritórios
CREATE TABLE offices (
  id          uuid PRIMARY KEY,
  name        text NOT NULL CHECK (char_length(name) BETWEEN 2 AND 120),
  created_by  uuid NOT NULL REFERENCES users(id),        -- informativo; não concede poderes
  created_at  timestamptz NOT NULL,
  join_code   text NOT NULL UNIQUE CHECK (join_code ~ '^[0-9A-HJKMNP-TV-Z]{10}$')
);

CREATE TABLE memberships (
  user_id         uuid PRIMARY KEY REFERENCES users(id), -- PK em user_id = no máximo UM escritório por usuário
  office_id       uuid NOT NULL REFERENCES offices(id),
  role_label      text NOT NULL CHECK (char_length(role_label) BETWEEN 1 AND 60),
  practice_areas  text[] NOT NULL DEFAULT '{}',
  permissions     text[] NOT NULL CHECK (permissions <@ ARRAY[
                    'deadline.read','deadline.create','deadline.edit','deadline.complete',
                    'deadline.transfer','team.manage','office.manage']::text[]),
  visibility      text NOT NULL CHECK (visibility IN ('all','assigned')),
  joined_at       timestamptz NOT NULL,
  CONSTRAINT memberships_user_office_key UNIQUE (user_id, office_id)   -- alvo das FKs de "responsável ativo"
);
CREATE INDEX memberships_office_idx ON memberships (office_id, joined_at);

CREATE TABLE invitations (
  id          uuid PRIMARY KEY,
  office_id   uuid NOT NULL REFERENCES offices(id),
  token_hash  text NOT NULL UNIQUE CHECK (char_length(token_hash) = 64),
  role_label  text NOT NULL,
  created_by  uuid NOT NULL REFERENCES users(id),
  created_at  timestamptz NOT NULL,
  expires_at  timestamptz NOT NULL,
  status      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','revoked')),
  closed_at   timestamptz,
  CHECK ((status = 'pending') = (closed_at IS NULL))
);
CREATE INDEX invitations_office_idx ON invitations (office_id, created_at DESC);

CREATE TABLE join_requests (
  id          uuid PRIMARY KEY,
  office_id   uuid NOT NULL REFERENCES offices(id),
  user_id     uuid NOT NULL REFERENCES users(id),
  created_at  timestamptz NOT NULL,
  status      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','cancelled')),
  decided_at  timestamptz,
  decided_by  uuid REFERENCES users(id),
  CHECK ((status = 'pending') = (decided_at IS NULL))
);
CREATE UNIQUE INDEX join_requests_one_pending ON join_requests (user_id, office_id) WHERE status = 'pending';
CREATE INDEX join_requests_office_idx ON join_requests (office_id, status, created_at DESC);
CREATE INDEX join_requests_user_idx ON join_requests (user_id, status, created_at DESC);

-- ------------------------------------------------------------------ prazos
CREATE TABLE deadlines (
  id              uuid PRIMARY KEY,
  scope_kind      text NOT NULL CHECK (scope_kind IN ('personal','office')),
  owner_id        uuid REFERENCES users(id),
  office_id       uuid REFERENCES offices(id),
  scope_key       text GENERATED ALWAYS AS (scope_kind || ':' || coalesce(owner_id::text, office_id::text)) STORED,
  title           text NOT NULL,
  case_number     text NOT NULL,
  court           text NOT NULL,
  practice_area   text NOT NULL,
  responsible_id  uuid NOT NULL REFERENCES users(id),
  status          text NOT NULL CHECK (status IN ('open','completed','cancelled')),
  priority        text NOT NULL CHECK (priority IN ('normal','high')),
  start_date      date NOT NULL,                          -- data CIVIL
  due_date        date NOT NULL,                          -- data CIVIL informada pelo usuário
  counting_mode   text NOT NULL CHECK (counting_mode IN ('business','calendar')),
  duration        integer NOT NULL CHECK (duration BETWEEN 1 AND 3650),
  reviewed        boolean NOT NULL,
  agenda_time     time,                                   -- horário civil, sem fuso
  created_by      uuid NOT NULL REFERENCES users(id),
  created_at      timestamptz NOT NULL,
  updated_at      timestamptz NOT NULL,
  version         integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  -- "Responsável ativo": preenchida SOMENTE para prazo em aberto do escritório. A FK abaixo
  -- obriga o responsável a ter vínculo ATUAL com esse escritório (checada no COMMIT).
  open_office_id  uuid,
  CHECK ((scope_kind = 'personal' AND owner_id IS NOT NULL AND office_id IS NULL)
      OR (scope_kind = 'office'   AND office_id IS NOT NULL AND owner_id IS NULL)),
  CHECK (due_date >= start_date),
  CHECK (open_office_id IS NOT DISTINCT FROM
         CASE WHEN status = 'open' AND scope_kind = 'office' THEN office_id END),
  CHECK (scope_kind = 'office' OR responsible_id = owner_id),
  CONSTRAINT deadlines_id_scope_key UNIQUE (id, scope_key),
  CONSTRAINT deadlines_active_responsible_fk FOREIGN KEY (responsible_id, open_office_id)
    REFERENCES memberships (user_id, office_id) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX deadlines_office_list_idx   ON deadlines (office_id, status, due_date) WHERE scope_kind = 'office';
CREATE INDEX deadlines_personal_list_idx ON deadlines (owner_id, status, due_date) WHERE scope_kind = 'personal';
CREATE INDEX deadlines_open_responsible_idx ON deadlines (open_office_id, responsible_id) WHERE open_office_id IS NOT NULL;

CREATE TABLE deadline_comments (
  id           uuid PRIMARY KEY,
  deadline_id  uuid NOT NULL REFERENCES deadlines(id),
  author_id    uuid NOT NULL REFERENCES users(id),
  text         text NOT NULL CHECK (char_length(text) BETWEEN 1 AND 2000),
  created_at   timestamptz NOT NULL
);
CREATE INDEX deadline_comments_idx ON deadline_comments (deadline_id, created_at, id);

CREATE TABLE deadline_history (
  id           uuid PRIMARY KEY,
  deadline_id  uuid NOT NULL REFERENCES deadlines(id),
  actor_id     uuid REFERENCES users(id),                 -- NULL = sistema
  action       text NOT NULL CHECK (action IN ('created','updated','reassigned','status_changed','transferred')),
  at           timestamptz NOT NULL,
  details      jsonb NOT NULL DEFAULT '{}'::jsonb         -- armazenado SEM projeção; a API projeta
);
CREATE INDEX deadline_history_idx ON deadline_history (deadline_id, at, id);

-- ------------------------------------------------------------------ intimações (somente metadados)
CREATE TABLE intimations (
  id                         uuid PRIMARY KEY,
  scope_kind                 text NOT NULL CHECK (scope_kind IN ('personal','office')),
  owner_id                   uuid REFERENCES users(id),
  office_id                  uuid REFERENCES offices(id),
  scope_key                  text GENERATED ALWAYS AS (scope_kind || ':' || coalesce(owner_id::text, office_id::text)) STORED,
  file_name                  text NOT NULL CHECK (char_length(file_name) BETWEEN 1 AND 255),
  file_size_bytes            integer NOT NULL CHECK (file_size_bytes BETWEEN 1 AND 10485760),
  file_content_type          text NOT NULL CHECK (file_content_type = 'application/pdf'),
  file_storage               text NOT NULL DEFAULT 'not_stored' CHECK (file_storage = 'not_stored'),
  received_at                date NOT NULL,              -- data CIVIL
  status                     text NOT NULL CHECK (status IN ('processing','awaiting_review','failed','reviewed','discarded')),
  processing_status          text NOT NULL DEFAULT 'not_available'
                               CHECK (processing_status IN ('not_available','pending','completed','failed')),
  processing_attempts        integer NOT NULL DEFAULT 0,
  processing_failure_code    text,
  draft_title                text,  draft_case_number  text,  draft_court text,  draft_practice_area text,
  draft_start_date           date,  draft_due_date     date,
  draft_counting_mode        text CHECK (draft_counting_mode IN ('business','calendar')),
  draft_duration             integer CHECK (draft_duration BETWEEN 1 AND 3650),
  draft_priority             text CHECK (draft_priority IN ('normal','high')),
  draft_agenda_time          time,
  suggestion                 jsonb,                     -- reservado ao processamento futuro
  suggested_responsible_id   uuid REFERENCES users(id),
  suggested_open_office_id   uuid,                      -- ver CHECK/FK de "sugerido ativo"
  deadline_id                uuid UNIQUE,               -- vínculo ÚNICO com o prazo
  created_by                 uuid NOT NULL REFERENCES users(id),
  created_at                 timestamptz NOT NULL,
  updated_at                 timestamptz NOT NULL,
  closed_at                  timestamptz,
  version                    integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  CHECK ((scope_kind = 'personal' AND owner_id IS NOT NULL AND office_id IS NULL)
      OR (scope_kind = 'office'   AND office_id IS NOT NULL AND owner_id IS NULL)),
  CHECK ((status = 'reviewed') = (deadline_id IS NOT NULL)),            -- revisada ⇔ vinculada
  CHECK ((status IN ('reviewed','discarded')) = (closed_at IS NOT NULL)),
  CHECK (suggested_open_office_id IS NOT DISTINCT FROM
         CASE WHEN status IN ('processing','awaiting_review','failed') AND scope_kind = 'office'
                   AND suggested_responsible_id IS NOT NULL THEN office_id END),
  -- vínculo consistente: o prazo existe e está no MESMO ambiente (checado no COMMIT,
  -- o que permite a transferência mudar prazo e intimação na mesma transação)
  CONSTRAINT intimations_deadline_same_scope_fk FOREIGN KEY (deadline_id, scope_key)
    REFERENCES deadlines (id, scope_key) DEFERRABLE INITIALLY DEFERRED,
  -- sugerido de pendência do escritório precisa ter vínculo ATUAL com ele
  CONSTRAINT intimations_suggested_active_fk FOREIGN KEY (suggested_responsible_id, suggested_open_office_id)
    REFERENCES memberships (user_id, office_id) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX intimations_office_list_idx   ON intimations (office_id, status, created_at DESC) WHERE scope_kind = 'office';
CREATE INDEX intimations_personal_list_idx ON intimations (owner_id, status, created_at DESC) WHERE scope_kind = 'personal';
CREATE INDEX intimations_discarded_purge_idx ON intimations (closed_at) WHERE status = 'discarded';

CREATE TABLE intimation_events (
  id             uuid PRIMARY KEY,
  intimation_id  uuid NOT NULL REFERENCES intimations(id) ON DELETE CASCADE,  -- some com a retenção do descarte
  actor_id       uuid REFERENCES users(id),               -- NULL = sistema
  action         text NOT NULL,
  at             timestamptz NOT NULL,
  details        jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX intimation_events_idx ON intimation_events (intimation_id, at, id);

-- ------------------------------------------------------------------ notificações internas
CREATE TABLE notifications (
  id             uuid PRIMARY KEY,
  recipient_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scope_kind     text NOT NULL CHECK (scope_kind IN ('personal','office')),
  owner_id       uuid REFERENCES users(id),
  office_id      uuid REFERENCES offices(id),
  kind           text NOT NULL CHECK (kind IN ('deadline_assigned','intimation_assigned')),
  deadline_id    uuid REFERENCES deadlines(id) ON DELETE CASCADE,
  intimation_id  uuid REFERENCES intimations(id) ON DELETE CASCADE,
  event_id       uuid NOT NULL,                           -- evento de histórico que originou (sem FK: duas origens)
  created_at     timestamptz NOT NULL,
  read_at        timestamptz,
  CHECK ((scope_kind = 'personal' AND owner_id IS NOT NULL AND office_id IS NULL)
      OR (scope_kind = 'office'   AND office_id IS NOT NULL AND owner_id IS NULL)),
  CHECK ((kind = 'deadline_assigned'   AND deadline_id IS NOT NULL AND intimation_id IS NULL)
      OR (kind = 'intimation_assigned' AND intimation_id IS NOT NULL AND deadline_id IS NULL)),
  CONSTRAINT notifications_dedupe_key UNIQUE (recipient_id, event_id)       -- deduplicação
);
CREATE INDEX notifications_inbox_idx  ON notifications (recipient_id, created_at DESC, id);
CREATE INDEX notifications_unread_idx ON notifications (recipient_id) WHERE read_at IS NULL;
CREATE INDEX notifications_read_purge_idx ON notifications (read_at) WHERE read_at IS NOT NULL;
