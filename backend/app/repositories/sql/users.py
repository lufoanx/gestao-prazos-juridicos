"""Usuários no PostgreSQL (`prazoai.users`)."""
from __future__ import annotations

from sqlalchemy import insert, select, update
from sqlalchemy.engine import Row
from sqlalchemy.exc import IntegrityError

from app.db.tables import users
from app.domain.auth import User
from app.repositories.auth import EmailAlreadyRegisteredError
from app.repositories.sql._base import SqlContext, to_hex, to_uuid, violated_constraint

EMAIL_UNIQUE = "uq_users_email"


def user_from_row(row: Row) -> User:
    return User(id=to_hex(row.id), name=row.name, email=row.email, password_hash=row.password_hash,
                created_at=row.created_at, credential_version=row.credential_version)


class SqlUserRepository:
    def __init__(self, ctx: SqlContext) -> None:
        self._ctx = ctx

    def add(self, user: User) -> None:
        """INSERT; corrida entre cadastros → a constraint UNIQUE decide (só ela vira 409)."""
        uid = to_uuid(user.id)
        if uid is None:
            raise ValueError("id de usuário inválido")
        try:
            with self._ctx.transaction() as conn:
                self._ctx.checkpoint("register:before_insert")
                conn.execute(insert(users).values(
                    id=uid, name=user.name, email=user.email, password_hash=user.password_hash,
                    credential_version=user.credential_version, created_at=user.created_at,
                ))
        except IntegrityError as exc:
            if violated_constraint(exc) == EMAIL_UNIQUE:
                raise EmailAlreadyRegisteredError() from None
            raise

    def get_by_id(self, user_id: str) -> User | None:
        uid = to_uuid(user_id)
        if uid is None:
            return None
        with self._ctx.read() as conn:
            row = conn.execute(select(users).where(users.c.id == uid)).first()
        return user_from_row(row) if row else None

    def get_by_email(self, email: str) -> User | None:
        """Hash e versão da credencial lidos JUNTOS, num único comando."""
        with self._ctx.read() as conn:
            row = conn.execute(select(users).where(users.c.email == email)).first()
        return user_from_row(row) if row else None

    def update_name(self, user_id: str, name: str) -> User | None:
        uid = to_uuid(user_id)
        if uid is None:
            return None
        with self._ctx.transaction() as conn:
            row = conn.execute(update(users).where(users.c.id == uid).values(name=name).returning(users)).first()
        return user_from_row(row) if row else None

    def update_password_hash_if_version(self, user_id: str, password_hash: str, expected_version: int) -> bool:
        """Rehash CONDICIONAL: não sobrescreve uma senha redefinida no meio (versão mudou)."""
        uid = to_uuid(user_id)
        if uid is None:
            return False
        with self._ctx.transaction() as conn:
            self._ctx.checkpoint("rehash:before_update")
            result = conn.execute(update(users).where(
                users.c.id == uid, users.c.credential_version == expected_version,
            ).values(password_hash=password_hash))
        return result.rowcount == 1
