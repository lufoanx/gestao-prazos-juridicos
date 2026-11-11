"""Intimações (somente metadados declarados) e eventos: intimations, intimation_events."""
from __future__ import annotations

from sqlalchemy import (
    CheckConstraint,
    Column,
    Date,
    ForeignKeyConstraint,
    Index,
    Integer,
    Table,
    Text,
    Time,
    UniqueConstraint,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID

from app.db.config import SCHEMA
from app.db.metadata import metadata
from app.db.tables._types import SCOPE_SHAPE_SQL, instant, scope_columns, uuid_fk, uuid_pk

PENDING_SQL = "status IN ('processing', 'awaiting_review', 'failed')"

intimations = Table(
    "intimations", metadata,
    uuid_pk(),
    *scope_columns("intimations"),
    Column("file_name", Text, nullable=False),
    Column("file_size_bytes", Integer, nullable=False),
    Column("file_content_type", Text, nullable=False),
    Column("file_storage", Text, nullable=False, server_default=text("'not_stored'")),
    Column("received_at", Date, nullable=False),                         # data CIVIL
    Column("status", Text, nullable=False),
    Column("processing_status", Text, nullable=False, server_default=text("'not_available'")),
    Column("processing_attempts", Integer, nullable=False, server_default=text("0")),
    Column("processing_failure_code", Text, nullable=True),
    Column("draft_title", Text, nullable=True),
    Column("draft_case_number", Text, nullable=True),
    Column("draft_court", Text, nullable=True),
    Column("draft_practice_area", Text, nullable=True),
    Column("draft_start_date", Date, nullable=True),
    Column("draft_due_date", Date, nullable=True),
    Column("draft_counting_mode", Text, nullable=True),
    Column("draft_duration", Integer, nullable=True),
    Column("draft_priority", Text, nullable=True),
    Column("draft_agenda_time", Time(timezone=False), nullable=True),
    Column("suggestion", JSONB, nullable=True),                          # reservado ao processamento futuro
    uuid_fk("suggested_responsible_id", "users", nullable=True,
            fk_name="fk_intimations_suggested_responsible_id_users"),
    Column("suggested_open_office_id", UUID(as_uuid=True), nullable=True),
    Column("deadline_id", UUID(as_uuid=True), nullable=True),            # vínculo ÚNICO com o prazo
    uuid_fk("created_by", "users", fk_name="fk_intimations_created_by_users"),
    instant("created_at"),
    instant("updated_at"),
    instant("closed_at", nullable=True),
    Column("version", Integer, nullable=False, server_default=text("1")),
    CheckConstraint(SCOPE_SHAPE_SQL, name="scope_shape"),
    CheckConstraint("char_length(file_name) BETWEEN 1 AND 255", name="file_name_length"),
    CheckConstraint("file_size_bytes BETWEEN 1 AND 10485760", name="file_size_range"),
    CheckConstraint("file_content_type = 'application/pdf'", name="file_content_type_pdf"),
    CheckConstraint("file_storage = 'not_stored'", name="file_not_stored"),
    CheckConstraint("status IN ('processing', 'awaiting_review', 'failed', 'reviewed', 'discarded')",
                    name="status_valid"),
    CheckConstraint("processing_status IN ('not_available', 'pending', 'completed', 'failed')",
                    name="processing_status_valid"),
    CheckConstraint("draft_counting_mode IN ('business', 'calendar')", name="draft_counting_mode_valid"),
    CheckConstraint("draft_duration BETWEEN 1 AND 3650", name="draft_duration_range"),
    CheckConstraint("draft_priority IN ('normal', 'high')", name="draft_priority_valid"),
    CheckConstraint("version >= 1", name="version_positive"),
    CheckConstraint("(status = 'reviewed') = (deadline_id IS NOT NULL)", name="reviewed_iff_linked"),
    CheckConstraint("(status IN ('reviewed', 'discarded')) = (closed_at IS NOT NULL)", name="closed_iff_terminal"),
    CheckConstraint(
        f"suggested_open_office_id IS NOT DISTINCT FROM CASE WHEN {PENDING_SQL} AND scope_kind = 'office' "
        "AND suggested_responsible_id IS NOT NULL THEN office_id END",
        name="suggested_open_office_matches",
    ),
    UniqueConstraint("deadline_id", name="uq_intimations_deadline_id"),
    # Vínculo consistente: o prazo existe e está no MESMO ambiente (verificado no COMMIT, o que
    # permite a transferência mudar prazo e intimação na mesma transação).
    ForeignKeyConstraint(
        ["deadline_id", "scope_key"], [f"{SCHEMA}.deadlines.id", f"{SCHEMA}.deadlines.scope_key"],
        name="fk_intimations_deadline_same_scope", deferrable=True, initially="DEFERRED",
    ),
    # Sugerido de pendência do escritório precisa ter vínculo ATUAL com ele.
    ForeignKeyConstraint(
        ["suggested_responsible_id", "suggested_open_office_id"],
        [f"{SCHEMA}.memberships.user_id", f"{SCHEMA}.memberships.office_id"],
        name="fk_intimations_suggested_active", deferrable=True, initially="DEFERRED",
    ),
)
Index("ix_intimations_office_list", intimations.c.office_id, intimations.c.status, intimations.c.created_at.desc(),
      postgresql_where=text("scope_kind = 'office'"))
Index("ix_intimations_personal_list", intimations.c.owner_id, intimations.c.status,
      intimations.c.created_at.desc(), postgresql_where=text("scope_kind = 'personal'"))
Index("ix_intimations_discarded_purge", intimations.c.closed_at, postgresql_where=text("status = 'discarded'"))

intimation_events = Table(
    "intimation_events", metadata,
    uuid_pk(),
    uuid_fk("intimation_id", "intimations", ondelete="CASCADE",
            fk_name="fk_intimation_events_intimation_id_intimations"),
    uuid_fk("actor_id", "users", nullable=True, fk_name="fk_intimation_events_actor_id_users"),   # NULL = sistema
    Column("action", Text, nullable=False),
    instant("at"),
    Column("details", JSONB, nullable=False, server_default=text("'{}'::jsonb")),
)
Index("ix_intimation_events_intimation_id_at", intimation_events.c.intimation_id, intimation_events.c.at,
      intimation_events.c.id)
