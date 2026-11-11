"""Identidade e sessões: users, auth_sessions, auth_used_refresh_hashes, password_reset_tokens."""
from __future__ import annotations

from sqlalchemy import CheckConstraint, Column, Index, Integer, Table, Text, UniqueConstraint, text

from app.db.metadata import metadata
from app.db.tables._types import instant, uuid_fk, uuid_pk

users = Table(
    "users", metadata,
    uuid_pk(),
    Column("name", Text, nullable=False),
    Column("email", Text, nullable=False),
    Column("password_hash", Text, nullable=False),                       # Argon2id
    Column("credential_version", Integer, nullable=False, server_default=text("0")),
    instant("created_at"),
    UniqueConstraint("email", name="uq_users_email"),                    # e-mail normalizado único
    CheckConstraint("char_length(name) BETWEEN 1 AND 120", name="name_length"),
    CheckConstraint("email = lower(email) AND char_length(email) <= 254", name="email_normalized"),
    CheckConstraint("credential_version >= 0", name="credential_version_nonnegative"),
)

auth_sessions = Table(
    "auth_sessions", metadata,
    uuid_pk(),
    uuid_fk("user_id", "users", ondelete="CASCADE", fk_name="fk_auth_sessions_user_id_users"),
    instant("created_at"),
    instant("expires_at"),
    Column("current_refresh_hash", Text, nullable=False),
    Column("credential_version", Integer, nullable=False),
    Column("rotation_count", Integer, nullable=False, server_default=text("0")),
    instant("revoked_at", nullable=True),
    UniqueConstraint("current_refresh_hash", name="uq_auth_sessions_current_refresh_hash"),
    CheckConstraint("char_length(current_refresh_hash) = 64", name="refresh_hash_length"),
    CheckConstraint("rotation_count >= 0", name="rotation_count_nonnegative"),
    CheckConstraint("expires_at > created_at", name="expires_after_created"),
)
Index("ix_auth_sessions_user_id_created_at", auth_sessions.c.user_id, auth_sessions.c.created_at)
Index("ix_auth_sessions_expires_at", auth_sessions.c.expires_at)

auth_used_refresh_hashes = Table(
    "auth_used_refresh_hashes", metadata,
    Column("refresh_hash", Text, primary_key=True),
    uuid_fk("session_id", "auth_sessions", ondelete="CASCADE",
            fk_name="fk_auth_used_refresh_hashes_session_id_auth_sessions"),
    instant("used_at"),
    CheckConstraint("char_length(refresh_hash) = 64", name="refresh_hash_length"),
)
Index("ix_auth_used_refresh_hashes_session_id", auth_used_refresh_hashes.c.session_id)

password_reset_tokens = Table(
    "password_reset_tokens", metadata,
    Column("token_hash", Text, primary_key=True),                         # SHA-256; nunca o token
    uuid_fk("user_id", "users", ondelete="CASCADE", fk_name="fk_password_reset_tokens_user_id_users"),
    instant("created_at"),
    instant("expires_at"),
    instant("used_at", nullable=True),
    instant("invalidated_at", nullable=True),
    CheckConstraint("char_length(token_hash) = 64", name="token_hash_length"),
)
# No máximo UM token não consumido e não invalidado por usuário (a expiração por tempo não entra no
# predicado: índices parciais não podem depender de now(); a emissão invalida o anterior).
Index("uq_password_reset_tokens_one_active_per_user", password_reset_tokens.c.user_id, unique=True,
      postgresql_where=text("used_at IS NULL AND invalidated_at IS NULL"))
