"""P2: esquema inicial do PrazoAI — as 14 tabelas aprovadas (doc 15), no esquema `prazoai`.

DDL EXPLÍCITO e revisado, independente dos metadados da aplicação (não usa create_all/drop_all):
a migration continua reproduzível quando `app/db/tables` evoluir. Todas as tabelas e referências
são qualificadas com o esquema, e todas as constraints e índices têm nomes estáveis.

O downgrade remove SOMENTE as 14 tabelas criadas aqui (com seus índices e constraints), em ordem
segura de dependência, com RESTRICT; não remove o esquema nem objetos externos à revisão.

Revisão: 0002
Anterior: 0001
"""
from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "0002"
down_revision: str | Sequence[str] | None = "0001"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

S = "prazoai"
SCOPE_KEY = "scope_kind || ':' || COALESCE(owner_id::text, office_id::text)"
SCOPE_SHAPE = (
    "(scope_kind = 'personal' AND owner_id IS NOT NULL AND office_id IS NULL) "
    "OR (scope_kind = 'office' AND office_id IS NOT NULL AND owner_id IS NULL)"
)
PERMISSIONS = ("ARRAY['deadline.read', 'deadline.create', 'deadline.edit', 'deadline.complete', "
               "'deadline.transfer', 'team.manage', 'office.manage']::text[]")

UPGRADE = [
    # ------------------------------------------------------------ identidade e sessões
    f"""CREATE TABLE {S}.users (
        id uuid NOT NULL,
        name text NOT NULL,
        email text NOT NULL,
        password_hash text NOT NULL,
        credential_version integer NOT NULL DEFAULT 0,
        created_at timestamptz NOT NULL,
        CONSTRAINT pk_users PRIMARY KEY (id),
        CONSTRAINT uq_users_email UNIQUE (email),
        CONSTRAINT ck_users_name_length CHECK (char_length(name) BETWEEN 1 AND 120),
        CONSTRAINT ck_users_email_normalized CHECK (email = lower(email) AND char_length(email) <= 254),
        CONSTRAINT ck_users_credential_version_nonnegative CHECK (credential_version >= 0)
    )""",
    f"""CREATE TABLE {S}.auth_sessions (
        id uuid NOT NULL,
        user_id uuid NOT NULL,
        created_at timestamptz NOT NULL,
        expires_at timestamptz NOT NULL,
        current_refresh_hash text NOT NULL,
        credential_version integer NOT NULL,
        rotation_count integer NOT NULL DEFAULT 0,
        revoked_at timestamptz,
        CONSTRAINT pk_auth_sessions PRIMARY KEY (id),
        CONSTRAINT fk_auth_sessions_user_id_users FOREIGN KEY (user_id) REFERENCES {S}.users (id) ON DELETE CASCADE,
        CONSTRAINT uq_auth_sessions_current_refresh_hash UNIQUE (current_refresh_hash),
        CONSTRAINT ck_auth_sessions_refresh_hash_length CHECK (char_length(current_refresh_hash) = 64),
        CONSTRAINT ck_auth_sessions_rotation_count_nonnegative CHECK (rotation_count >= 0),
        CONSTRAINT ck_auth_sessions_expires_after_created CHECK (expires_at > created_at)
    )""",
    f"CREATE INDEX ix_auth_sessions_user_id_created_at ON {S}.auth_sessions (user_id, created_at)",
    f"CREATE INDEX ix_auth_sessions_expires_at ON {S}.auth_sessions (expires_at)",
    f"""CREATE TABLE {S}.auth_used_refresh_hashes (
        refresh_hash text NOT NULL,
        session_id uuid NOT NULL,
        used_at timestamptz NOT NULL,
        CONSTRAINT pk_auth_used_refresh_hashes PRIMARY KEY (refresh_hash),
        CONSTRAINT fk_auth_used_refresh_hashes_session_id_auth_sessions FOREIGN KEY (session_id)
            REFERENCES {S}.auth_sessions (id) ON DELETE CASCADE,
        CONSTRAINT ck_auth_used_refresh_hashes_refresh_hash_length CHECK (char_length(refresh_hash) = 64)
    )""",
    f"CREATE INDEX ix_auth_used_refresh_hashes_session_id ON {S}.auth_used_refresh_hashes (session_id)",
    f"""CREATE TABLE {S}.password_reset_tokens (
        token_hash text NOT NULL,
        user_id uuid NOT NULL,
        created_at timestamptz NOT NULL,
        expires_at timestamptz NOT NULL,
        used_at timestamptz,
        invalidated_at timestamptz,
        CONSTRAINT pk_password_reset_tokens PRIMARY KEY (token_hash),
        CONSTRAINT fk_password_reset_tokens_user_id_users FOREIGN KEY (user_id) REFERENCES {S}.users (id)
            ON DELETE CASCADE,
        CONSTRAINT ck_password_reset_tokens_token_hash_length CHECK (char_length(token_hash) = 64)
    )""",
    f"""CREATE UNIQUE INDEX uq_password_reset_tokens_one_active_per_user ON {S}.password_reset_tokens (user_id)
        WHERE used_at IS NULL AND invalidated_at IS NULL""",
    # ------------------------------------------------------------ escritórios
    f"""CREATE TABLE {S}.offices (
        id uuid NOT NULL,
        name text NOT NULL,
        created_by uuid NOT NULL,
        created_at timestamptz NOT NULL,
        join_code text NOT NULL,
        CONSTRAINT pk_offices PRIMARY KEY (id),
        CONSTRAINT fk_offices_created_by_users FOREIGN KEY (created_by) REFERENCES {S}.users (id),
        CONSTRAINT uq_offices_join_code UNIQUE (join_code),
        CONSTRAINT ck_offices_name_length CHECK (char_length(name) BETWEEN 2 AND 120),
        CONSTRAINT ck_offices_join_code_format CHECK (join_code ~ '^[0-9A-HJKMNP-TV-Z]{{10}}$')
    )""",
    f"""CREATE TABLE {S}.memberships (
        user_id uuid NOT NULL,
        office_id uuid NOT NULL,
        role_label text NOT NULL,
        practice_areas text[] NOT NULL DEFAULT '{{}}'::text[],
        permissions text[] NOT NULL,
        visibility text NOT NULL,
        joined_at timestamptz NOT NULL,
        CONSTRAINT pk_memberships PRIMARY KEY (user_id),
        CONSTRAINT fk_memberships_user_id_users FOREIGN KEY (user_id) REFERENCES {S}.users (id),
        CONSTRAINT fk_memberships_office_id_offices FOREIGN KEY (office_id) REFERENCES {S}.offices (id),
        CONSTRAINT uq_memberships_user_id_office_id UNIQUE (user_id, office_id),
        CONSTRAINT ck_memberships_role_label_length CHECK (char_length(role_label) BETWEEN 1 AND 60),
        CONSTRAINT ck_memberships_permissions_known CHECK (permissions <@ {PERMISSIONS}),
        CONSTRAINT ck_memberships_visibility_valid CHECK (visibility IN ('all', 'assigned'))
    )""",
    f"CREATE INDEX ix_memberships_office_id_joined_at ON {S}.memberships (office_id, joined_at)",
    f"""CREATE TABLE {S}.invitations (
        id uuid NOT NULL,
        office_id uuid NOT NULL,
        token_hash text NOT NULL,
        role_label text NOT NULL,
        created_by uuid NOT NULL,
        created_at timestamptz NOT NULL,
        expires_at timestamptz NOT NULL,
        status text NOT NULL DEFAULT 'pending',
        closed_at timestamptz,
        CONSTRAINT pk_invitations PRIMARY KEY (id),
        CONSTRAINT fk_invitations_office_id_offices FOREIGN KEY (office_id) REFERENCES {S}.offices (id),
        CONSTRAINT fk_invitations_created_by_users FOREIGN KEY (created_by) REFERENCES {S}.users (id),
        CONSTRAINT uq_invitations_token_hash UNIQUE (token_hash),
        CONSTRAINT ck_invitations_token_hash_length CHECK (char_length(token_hash) = 64),
        CONSTRAINT ck_invitations_status_valid CHECK (status IN ('pending', 'accepted', 'revoked')),
        CONSTRAINT ck_invitations_closed_iff_not_pending CHECK ((status = 'pending') = (closed_at IS NULL))
    )""",
    f"CREATE INDEX ix_invitations_office_id_created_at ON {S}.invitations (office_id, created_at DESC)",
    f"""CREATE TABLE {S}.join_requests (
        id uuid NOT NULL,
        office_id uuid NOT NULL,
        user_id uuid NOT NULL,
        created_at timestamptz NOT NULL,
        status text NOT NULL DEFAULT 'pending',
        decided_at timestamptz,
        decided_by uuid,
        CONSTRAINT pk_join_requests PRIMARY KEY (id),
        CONSTRAINT fk_join_requests_office_id_offices FOREIGN KEY (office_id) REFERENCES {S}.offices (id),
        CONSTRAINT fk_join_requests_user_id_users FOREIGN KEY (user_id) REFERENCES {S}.users (id),
        CONSTRAINT fk_join_requests_decided_by_users FOREIGN KEY (decided_by) REFERENCES {S}.users (id),
        CONSTRAINT ck_join_requests_status_valid CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
        CONSTRAINT ck_join_requests_decided_iff_not_pending CHECK ((status = 'pending') = (decided_at IS NULL))
    )""",
    f"""CREATE UNIQUE INDEX uq_join_requests_one_pending ON {S}.join_requests (user_id, office_id)
        WHERE status = 'pending'""",
    f"""CREATE INDEX ix_join_requests_office_id_status_created_at
        ON {S}.join_requests (office_id, status, created_at DESC)""",
    f"CREATE INDEX ix_join_requests_user_id_status_created_at ON {S}.join_requests (user_id, status, created_at DESC)",
    # ------------------------------------------------------------ prazos
    f"""CREATE TABLE {S}.deadlines (
        id uuid NOT NULL,
        scope_kind text NOT NULL,
        owner_id uuid,
        office_id uuid,
        scope_key text GENERATED ALWAYS AS ({SCOPE_KEY}) STORED,
        title text NOT NULL,
        case_number text NOT NULL,
        court text NOT NULL,
        practice_area text NOT NULL,
        responsible_id uuid NOT NULL,
        status text NOT NULL,
        priority text NOT NULL,
        start_date date NOT NULL,
        due_date date NOT NULL,
        counting_mode text NOT NULL,
        duration integer NOT NULL,
        reviewed boolean NOT NULL,
        agenda_time time without time zone,
        created_by uuid NOT NULL,
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL,
        version integer NOT NULL DEFAULT 1,
        open_office_id uuid,
        CONSTRAINT pk_deadlines PRIMARY KEY (id),
        CONSTRAINT fk_deadlines_owner_id_users FOREIGN KEY (owner_id) REFERENCES {S}.users (id),
        CONSTRAINT fk_deadlines_office_id_offices FOREIGN KEY (office_id) REFERENCES {S}.offices (id),
        CONSTRAINT fk_deadlines_responsible_id_users FOREIGN KEY (responsible_id) REFERENCES {S}.users (id),
        CONSTRAINT fk_deadlines_created_by_users FOREIGN KEY (created_by) REFERENCES {S}.users (id),
        CONSTRAINT ck_deadlines_scope_shape CHECK ({SCOPE_SHAPE}),
        CONSTRAINT ck_deadlines_status_valid CHECK (status IN ('open', 'completed', 'cancelled')),
        CONSTRAINT ck_deadlines_priority_valid CHECK (priority IN ('normal', 'high')),
        CONSTRAINT ck_deadlines_counting_mode_valid CHECK (counting_mode IN ('business', 'calendar')),
        CONSTRAINT ck_deadlines_duration_range CHECK (duration BETWEEN 1 AND 3650),
        CONSTRAINT ck_deadlines_version_positive CHECK (version >= 1),
        CONSTRAINT ck_deadlines_due_after_start CHECK (due_date >= start_date),
        CONSTRAINT ck_deadlines_open_office_matches_status CHECK (open_office_id IS NOT DISTINCT FROM
            CASE WHEN status = 'open' AND scope_kind = 'office' THEN office_id END),
        CONSTRAINT ck_deadlines_personal_responsible_is_owner CHECK
            (scope_kind = 'office' OR responsible_id = owner_id),
        CONSTRAINT uq_deadlines_id_scope_key UNIQUE (id, scope_key),
        CONSTRAINT fk_deadlines_active_responsible FOREIGN KEY (responsible_id, open_office_id)
            REFERENCES {S}.memberships (user_id, office_id) DEFERRABLE INITIALLY DEFERRED
    )""",
    f"""CREATE INDEX ix_deadlines_office_list ON {S}.deadlines (office_id, status, due_date)
        WHERE scope_kind = 'office'""",
    f"""CREATE INDEX ix_deadlines_personal_list ON {S}.deadlines (owner_id, status, due_date)
        WHERE scope_kind = 'personal'""",
    f"""CREATE INDEX ix_deadlines_open_responsible ON {S}.deadlines (open_office_id, responsible_id)
        WHERE open_office_id IS NOT NULL""",
    f"""CREATE TABLE {S}.deadline_comments (
        id uuid NOT NULL,
        deadline_id uuid NOT NULL,
        author_id uuid NOT NULL,
        text text NOT NULL,
        created_at timestamptz NOT NULL,
        CONSTRAINT pk_deadline_comments PRIMARY KEY (id),
        CONSTRAINT fk_deadline_comments_deadline_id_deadlines FOREIGN KEY (deadline_id) REFERENCES {S}.deadlines (id),
        CONSTRAINT fk_deadline_comments_author_id_users FOREIGN KEY (author_id) REFERENCES {S}.users (id),
        CONSTRAINT ck_deadline_comments_text_length CHECK (char_length(text) BETWEEN 1 AND 2000)
    )""",
    f"""CREATE INDEX ix_deadline_comments_deadline_id_created_at
        ON {S}.deadline_comments (deadline_id, created_at, id)""",
    f"""CREATE TABLE {S}.deadline_history (
        id uuid NOT NULL,
        deadline_id uuid NOT NULL,
        actor_id uuid,
        action text NOT NULL,
        at timestamptz NOT NULL,
        details jsonb NOT NULL DEFAULT '{{}}'::jsonb,
        CONSTRAINT pk_deadline_history PRIMARY KEY (id),
        CONSTRAINT fk_deadline_history_deadline_id_deadlines FOREIGN KEY (deadline_id) REFERENCES {S}.deadlines (id),
        CONSTRAINT fk_deadline_history_actor_id_users FOREIGN KEY (actor_id) REFERENCES {S}.users (id),
        CONSTRAINT ck_deadline_history_action_valid CHECK (action IN
            ('created', 'updated', 'reassigned', 'status_changed', 'transferred'))
    )""",
    f"CREATE INDEX ix_deadline_history_deadline_id_at ON {S}.deadline_history (deadline_id, at, id)",
    # ------------------------------------------------------------ intimações
    f"""CREATE TABLE {S}.intimations (
        id uuid NOT NULL,
        scope_kind text NOT NULL,
        owner_id uuid,
        office_id uuid,
        scope_key text GENERATED ALWAYS AS ({SCOPE_KEY}) STORED,
        file_name text NOT NULL,
        file_size_bytes integer NOT NULL,
        file_content_type text NOT NULL,
        file_storage text NOT NULL DEFAULT 'not_stored',
        received_at date NOT NULL,
        status text NOT NULL,
        processing_status text NOT NULL DEFAULT 'not_available',
        processing_attempts integer NOT NULL DEFAULT 0,
        processing_failure_code text,
        draft_title text,
        draft_case_number text,
        draft_court text,
        draft_practice_area text,
        draft_start_date date,
        draft_due_date date,
        draft_counting_mode text,
        draft_duration integer,
        draft_priority text,
        draft_agenda_time time without time zone,
        suggestion jsonb,
        suggested_responsible_id uuid,
        suggested_open_office_id uuid,
        deadline_id uuid,
        created_by uuid NOT NULL,
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL,
        closed_at timestamptz,
        version integer NOT NULL DEFAULT 1,
        CONSTRAINT pk_intimations PRIMARY KEY (id),
        CONSTRAINT fk_intimations_owner_id_users FOREIGN KEY (owner_id) REFERENCES {S}.users (id),
        CONSTRAINT fk_intimations_office_id_offices FOREIGN KEY (office_id) REFERENCES {S}.offices (id),
        CONSTRAINT fk_intimations_suggested_responsible_id_users FOREIGN KEY (suggested_responsible_id)
            REFERENCES {S}.users (id),
        CONSTRAINT fk_intimations_created_by_users FOREIGN KEY (created_by) REFERENCES {S}.users (id),
        CONSTRAINT ck_intimations_scope_shape CHECK ({SCOPE_SHAPE}),
        CONSTRAINT ck_intimations_file_name_length CHECK (char_length(file_name) BETWEEN 1 AND 255),
        CONSTRAINT ck_intimations_file_size_range CHECK (file_size_bytes BETWEEN 1 AND 10485760),
        CONSTRAINT ck_intimations_file_content_type_pdf CHECK (file_content_type = 'application/pdf'),
        CONSTRAINT ck_intimations_file_not_stored CHECK (file_storage = 'not_stored'),
        CONSTRAINT ck_intimations_status_valid CHECK (status IN
            ('processing', 'awaiting_review', 'failed', 'reviewed', 'discarded')),
        CONSTRAINT ck_intimations_processing_status_valid CHECK (processing_status IN
            ('not_available', 'pending', 'completed', 'failed')),
        CONSTRAINT ck_intimations_draft_counting_mode_valid CHECK (draft_counting_mode IN ('business', 'calendar')),
        CONSTRAINT ck_intimations_draft_duration_range CHECK (draft_duration BETWEEN 1 AND 3650),
        CONSTRAINT ck_intimations_draft_priority_valid CHECK (draft_priority IN ('normal', 'high')),
        CONSTRAINT ck_intimations_version_positive CHECK (version >= 1),
        CONSTRAINT ck_intimations_reviewed_iff_linked CHECK ((status = 'reviewed') = (deadline_id IS NOT NULL)),
        CONSTRAINT ck_intimations_closed_iff_terminal CHECK
            ((status IN ('reviewed', 'discarded')) = (closed_at IS NOT NULL)),
        CONSTRAINT ck_intimations_suggested_open_office_matches CHECK (suggested_open_office_id IS NOT DISTINCT FROM
            CASE WHEN status IN ('processing', 'awaiting_review', 'failed') AND scope_kind = 'office'
                 AND suggested_responsible_id IS NOT NULL THEN office_id END),
        CONSTRAINT uq_intimations_deadline_id UNIQUE (deadline_id),
        CONSTRAINT fk_intimations_deadline_same_scope FOREIGN KEY (deadline_id, scope_key)
            REFERENCES {S}.deadlines (id, scope_key) DEFERRABLE INITIALLY DEFERRED,
        CONSTRAINT fk_intimations_suggested_active FOREIGN KEY (suggested_responsible_id, suggested_open_office_id)
            REFERENCES {S}.memberships (user_id, office_id) DEFERRABLE INITIALLY DEFERRED
    )""",
    f"""CREATE INDEX ix_intimations_office_list ON {S}.intimations (office_id, status, created_at DESC)
        WHERE scope_kind = 'office'""",
    f"""CREATE INDEX ix_intimations_personal_list ON {S}.intimations (owner_id, status, created_at DESC)
        WHERE scope_kind = 'personal'""",
    f"""CREATE INDEX ix_intimations_discarded_purge ON {S}.intimations (closed_at)
        WHERE status = 'discarded'""",
    f"""CREATE TABLE {S}.intimation_events (
        id uuid NOT NULL,
        intimation_id uuid NOT NULL,
        actor_id uuid,
        action text NOT NULL,
        at timestamptz NOT NULL,
        details jsonb NOT NULL DEFAULT '{{}}'::jsonb,
        CONSTRAINT pk_intimation_events PRIMARY KEY (id),
        CONSTRAINT fk_intimation_events_intimation_id_intimations FOREIGN KEY (intimation_id)
            REFERENCES {S}.intimations (id) ON DELETE CASCADE,
        CONSTRAINT fk_intimation_events_actor_id_users FOREIGN KEY (actor_id) REFERENCES {S}.users (id)
    )""",
    f"CREATE INDEX ix_intimation_events_intimation_id_at ON {S}.intimation_events (intimation_id, at, id)",
    # ------------------------------------------------------------ notificações
    f"""CREATE TABLE {S}.notifications (
        id uuid NOT NULL,
        recipient_id uuid NOT NULL,
        scope_kind text NOT NULL,
        owner_id uuid,
        office_id uuid,
        kind text NOT NULL,
        deadline_id uuid,
        intimation_id uuid,
        event_id uuid NOT NULL,
        created_at timestamptz NOT NULL,
        read_at timestamptz,
        CONSTRAINT pk_notifications PRIMARY KEY (id),
        CONSTRAINT fk_notifications_recipient_id_users FOREIGN KEY (recipient_id) REFERENCES {S}.users (id)
            ON DELETE CASCADE,
        CONSTRAINT fk_notifications_owner_id_users FOREIGN KEY (owner_id) REFERENCES {S}.users (id),
        CONSTRAINT fk_notifications_office_id_offices FOREIGN KEY (office_id) REFERENCES {S}.offices (id),
        CONSTRAINT fk_notifications_deadline_id_deadlines FOREIGN KEY (deadline_id) REFERENCES {S}.deadlines (id)
            ON DELETE CASCADE,
        CONSTRAINT fk_notifications_intimation_id_intimations FOREIGN KEY (intimation_id)
            REFERENCES {S}.intimations (id) ON DELETE CASCADE,
        CONSTRAINT ck_notifications_scope_shape CHECK ({SCOPE_SHAPE}),
        CONSTRAINT ck_notifications_kind_valid CHECK (kind IN ('deadline_assigned', 'intimation_assigned')),
        CONSTRAINT ck_notifications_resource_matches_kind CHECK (
            (kind = 'deadline_assigned' AND deadline_id IS NOT NULL AND intimation_id IS NULL)
            OR (kind = 'intimation_assigned' AND intimation_id IS NOT NULL AND deadline_id IS NULL)),
        CONSTRAINT uq_notifications_recipient_id_event_id UNIQUE (recipient_id, event_id)
    )""",
    f"CREATE INDEX ix_notifications_inbox ON {S}.notifications (recipient_id, created_at DESC, id)",
    f"CREATE INDEX ix_notifications_unread ON {S}.notifications (recipient_id) WHERE read_at IS NULL",
    f"CREATE INDEX ix_notifications_read_purge ON {S}.notifications (read_at) WHERE read_at IS NOT NULL",
]

#: Ordem segura (dependentes antes das dependências). Só as tabelas desta revisão.
DOWNGRADE_ORDER = (
    "notifications", "intimation_events", "intimations",
    "deadline_history", "deadline_comments", "deadlines",
    "join_requests", "invitations", "memberships", "offices",
    "password_reset_tokens", "auth_used_refresh_hashes", "auth_sessions", "users",
)


def upgrade() -> None:
    for statement in UPGRADE:
        op.execute(statement)


def downgrade() -> None:
    for table in DOWNGRADE_ORDER:
        op.execute(f"DROP TABLE {S}.{table} RESTRICT")
