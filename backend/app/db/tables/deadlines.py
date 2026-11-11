"""Prazos: deadlines, deadline_comments, deadline_history."""
from __future__ import annotations

from sqlalchemy import (
    Boolean,
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

deadlines = Table(
    "deadlines", metadata,
    uuid_pk(),
    *scope_columns("deadlines"),
    Column("title", Text, nullable=False),
    Column("case_number", Text, nullable=False),
    Column("court", Text, nullable=False),
    Column("practice_area", Text, nullable=False),
    uuid_fk("responsible_id", "users", fk_name="fk_deadlines_responsible_id_users"),
    Column("status", Text, nullable=False),
    Column("priority", Text, nullable=False),
    Column("start_date", Date, nullable=False),                          # data CIVIL
    Column("due_date", Date, nullable=False),                            # data CIVIL informada pelo usuário
    Column("counting_mode", Text, nullable=False),
    Column("duration", Integer, nullable=False),
    Column("reviewed", Boolean, nullable=False),
    Column("agenda_time", Time(timezone=False), nullable=True),          # horário civil, sem fuso
    uuid_fk("created_by", "users", fk_name="fk_deadlines_created_by_users"),
    instant("created_at"),
    instant("updated_at"),
    Column("version", Integer, nullable=False, server_default=text("1")),
    # Preenchida SOMENTE em prazo aberto do escritório: a FK diferida abaixo obriga o responsável a
    # ter vínculo ATUAL com esse escritório (verificada no COMMIT).
    Column("open_office_id", UUID(as_uuid=True), nullable=True),
    CheckConstraint(SCOPE_SHAPE_SQL, name="scope_shape"),
    CheckConstraint("status IN ('open', 'completed', 'cancelled')", name="status_valid"),
    CheckConstraint("priority IN ('normal', 'high')", name="priority_valid"),
    CheckConstraint("counting_mode IN ('business', 'calendar')", name="counting_mode_valid"),
    CheckConstraint("duration BETWEEN 1 AND 3650", name="duration_range"),
    CheckConstraint("version >= 1", name="version_positive"),
    CheckConstraint("due_date >= start_date", name="due_after_start"),
    CheckConstraint(
        "open_office_id IS NOT DISTINCT FROM CASE WHEN status = 'open' AND scope_kind = 'office' "
        "THEN office_id END",
        name="open_office_matches_status",
    ),
    CheckConstraint("scope_kind = 'office' OR responsible_id = owner_id", name="personal_responsible_is_owner"),
    UniqueConstraint("id", "scope_key", name="uq_deadlines_id_scope_key"),
    ForeignKeyConstraint(
        ["responsible_id", "open_office_id"], [f"{SCHEMA}.memberships.user_id", f"{SCHEMA}.memberships.office_id"],
        name="fk_deadlines_active_responsible", deferrable=True, initially="DEFERRED",
    ),
)
Index("ix_deadlines_office_list", deadlines.c.office_id, deadlines.c.status, deadlines.c.due_date,
      postgresql_where=text("scope_kind = 'office'"))
Index("ix_deadlines_personal_list", deadlines.c.owner_id, deadlines.c.status, deadlines.c.due_date,
      postgresql_where=text("scope_kind = 'personal'"))
Index("ix_deadlines_open_responsible", deadlines.c.open_office_id, deadlines.c.responsible_id,
      postgresql_where=text("open_office_id IS NOT NULL"))

deadline_comments = Table(
    "deadline_comments", metadata,
    uuid_pk(),
    uuid_fk("deadline_id", "deadlines", fk_name="fk_deadline_comments_deadline_id_deadlines"),
    uuid_fk("author_id", "users", fk_name="fk_deadline_comments_author_id_users"),
    Column("text", Text, nullable=False),
    instant("created_at"),
    CheckConstraint("char_length(text) BETWEEN 1 AND 2000", name="text_length"),
)
Index("ix_deadline_comments_deadline_id_created_at", deadline_comments.c.deadline_id,
      deadline_comments.c.created_at, deadline_comments.c.id)

deadline_history = Table(
    "deadline_history", metadata,
    uuid_pk(),
    uuid_fk("deadline_id", "deadlines", fk_name="fk_deadline_history_deadline_id_deadlines"),
    uuid_fk("actor_id", "users", nullable=True, fk_name="fk_deadline_history_actor_id_users"),   # NULL = sistema
    Column("action", Text, nullable=False),
    instant("at"),
    Column("details", JSONB, nullable=False, server_default=text("'{}'::jsonb")),   # SEM projeção
    CheckConstraint("action IN ('created', 'updated', 'reassigned', 'status_changed', 'transferred')",
                    name="action_valid"),
)
Index("ix_deadline_history_deadline_id_at", deadline_history.c.deadline_id, deadline_history.c.at,
      deadline_history.c.id)
