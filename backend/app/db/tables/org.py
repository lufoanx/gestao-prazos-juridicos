"""Escritórios: offices, memberships, invitations, join_requests."""
from __future__ import annotations

from sqlalchemy import CheckConstraint, Column, ForeignKey, Index, Table, Text, UniqueConstraint, text
from sqlalchemy.dialects.postgresql import ARRAY, UUID

from app.db.metadata import metadata
from app.db.tables._types import instant, ref, uuid_fk, uuid_pk

PERMISSIONS = ("deadline.read", "deadline.create", "deadline.edit", "deadline.complete",
               "deadline.transfer", "team.manage", "office.manage")
_PERMISSIONS_SQL = "ARRAY[" + ", ".join(f"'{p}'" for p in PERMISSIONS) + "]::text[]"

offices = Table(
    "offices", metadata,
    uuid_pk(),
    Column("name", Text, nullable=False),
    uuid_fk("created_by", "users", fk_name="fk_offices_created_by_users"),    # informativo; não concede poderes
    instant("created_at"),
    Column("join_code", Text, nullable=False),
    UniqueConstraint("join_code", name="uq_offices_join_code"),
    CheckConstraint("char_length(name) BETWEEN 2 AND 120", name="name_length"),
    CheckConstraint("join_code ~ '^[0-9A-HJKMNP-TV-Z]{10}$'", name="join_code_format"),
)

memberships = Table(
    "memberships", metadata,
    # PK em user_id = no máximo UM escritório por usuário.
    Column("user_id", UUID(as_uuid=True), ForeignKey(ref("users"), name="fk_memberships_user_id_users"),
           primary_key=True),
    uuid_fk("office_id", "offices", fk_name="fk_memberships_office_id_offices"),
    Column("role_label", Text, nullable=False),
    Column("practice_areas", ARRAY(Text), nullable=False, server_default=text("'{}'::text[]")),
    Column("permissions", ARRAY(Text), nullable=False),
    Column("visibility", Text, nullable=False),
    instant("joined_at"),
    # Alvo das FKs compostas de "responsável/sugerido ATIVO" (prazos e intimações).
    UniqueConstraint("user_id", "office_id", name="uq_memberships_user_id_office_id"),
    CheckConstraint("char_length(role_label) BETWEEN 1 AND 60", name="role_label_length"),
    CheckConstraint(f"permissions <@ {_PERMISSIONS_SQL}", name="permissions_known"),
    CheckConstraint("visibility IN ('all', 'assigned')", name="visibility_valid"),
)
Index("ix_memberships_office_id_joined_at", memberships.c.office_id, memberships.c.joined_at)

invitations = Table(
    "invitations", metadata,
    uuid_pk(),
    uuid_fk("office_id", "offices", fk_name="fk_invitations_office_id_offices"),
    Column("token_hash", Text, nullable=False),
    Column("role_label", Text, nullable=False),
    uuid_fk("created_by", "users", fk_name="fk_invitations_created_by_users"),
    instant("created_at"),
    instant("expires_at"),
    Column("status", Text, nullable=False, server_default=text("'pending'")),
    instant("closed_at", nullable=True),
    UniqueConstraint("token_hash", name="uq_invitations_token_hash"),
    CheckConstraint("char_length(token_hash) = 64", name="token_hash_length"),
    CheckConstraint("status IN ('pending', 'accepted', 'revoked')", name="status_valid"),
    CheckConstraint("(status = 'pending') = (closed_at IS NULL)", name="closed_iff_not_pending"),
)
Index("ix_invitations_office_id_created_at", invitations.c.office_id, invitations.c.created_at.desc())

join_requests = Table(
    "join_requests", metadata,
    uuid_pk(),
    uuid_fk("office_id", "offices", fk_name="fk_join_requests_office_id_offices"),
    uuid_fk("user_id", "users", fk_name="fk_join_requests_user_id_users"),
    instant("created_at"),
    Column("status", Text, nullable=False, server_default=text("'pending'")),
    instant("decided_at", nullable=True),
    uuid_fk("decided_by", "users", nullable=True, fk_name="fk_join_requests_decided_by_users"),
    CheckConstraint("status IN ('pending', 'approved', 'rejected', 'cancelled')", name="status_valid"),
    CheckConstraint("(status = 'pending') = (decided_at IS NULL)", name="decided_iff_not_pending"),
)
Index("uq_join_requests_one_pending", join_requests.c.user_id, join_requests.c.office_id, unique=True,
      postgresql_where=text("status = 'pending'"))
Index("ix_join_requests_office_id_status_created_at", join_requests.c.office_id, join_requests.c.status,
      join_requests.c.created_at.desc())
Index("ix_join_requests_user_id_status_created_at", join_requests.c.user_id, join_requests.c.status,
      join_requests.c.created_at.desc())
