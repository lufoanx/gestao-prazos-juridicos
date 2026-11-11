"""Notificações internas individuais: notifications (deduplicadas por destinatário + evento)."""
from __future__ import annotations

from sqlalchemy import CheckConstraint, Column, Index, Table, Text, UniqueConstraint, text
from sqlalchemy.dialects.postgresql import UUID

from app.db.metadata import metadata
from app.db.tables._types import SCOPE_SHAPE_SQL, instant, uuid_fk, uuid_pk

notifications = Table(
    "notifications", metadata,
    uuid_pk(),
    uuid_fk("recipient_id", "users", ondelete="CASCADE", fk_name="fk_notifications_recipient_id_users"),
    Column("scope_kind", Text, nullable=False),
    uuid_fk("owner_id", "users", nullable=True, fk_name="fk_notifications_owner_id_users"),
    uuid_fk("office_id", "offices", nullable=True, fk_name="fk_notifications_office_id_offices"),
    Column("kind", Text, nullable=False),
    uuid_fk("deadline_id", "deadlines", nullable=True, ondelete="CASCADE",
            fk_name="fk_notifications_deadline_id_deadlines"),
    uuid_fk("intimation_id", "intimations", nullable=True, ondelete="CASCADE",
            fk_name="fk_notifications_intimation_id_intimations"),
    Column("event_id", UUID(as_uuid=True), nullable=False),              # evento de origem (sem FK: duas origens)
    instant("created_at"),
    instant("read_at", nullable=True),
    CheckConstraint(SCOPE_SHAPE_SQL, name="scope_shape"),
    CheckConstraint("kind IN ('deadline_assigned', 'intimation_assigned')", name="kind_valid"),
    CheckConstraint(
        "(kind = 'deadline_assigned' AND deadline_id IS NOT NULL AND intimation_id IS NULL) "
        "OR (kind = 'intimation_assigned' AND intimation_id IS NOT NULL AND deadline_id IS NULL)",
        name="resource_matches_kind",
    ),
    UniqueConstraint("recipient_id", "event_id", name="uq_notifications_recipient_id_event_id"),   # deduplicação
)
Index("ix_notifications_inbox", notifications.c.recipient_id, notifications.c.created_at.desc(), notifications.c.id)
Index("ix_notifications_unread", notifications.c.recipient_id, postgresql_where=text("read_at IS NULL"))
Index("ix_notifications_read_purge", notifications.c.read_at, postgresql_where=text("read_at IS NOT NULL"))
