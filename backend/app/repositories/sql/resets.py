"""Tokens de recuperação de senha e redefinição completa no PostgreSQL.

Ordem de bloqueios: users → password_reset_tokens → auth_sessions. A redefinição é UMA transação:
consumo do token + nova senha (credential_version + 1) + invalidação dos demais tokens + revogação
de todas as sessões. Argon2 já foi calculado ANTES, fora da transação (no serviço).
"""
from __future__ import annotations

from datetime import datetime

from sqlalchemy import Connection, delete, insert, or_, select, update

from app.db.tables import auth_sessions, password_reset_tokens, users
from app.domain.auth import PasswordResetToken
from app.repositories.sql._base import SqlContext, to_hex, to_uuid

T = password_reset_tokens


def _active(row, now: datetime) -> bool:
    return row is not None and row.used_at is None and row.invalidated_at is None and now < row.expires_at


class SqlPasswordResetRepository:
    def __init__(self, ctx: SqlContext) -> None:
        self._ctx = ctx

    def issue_replacing_active(self, token: PasswordResetToken, now: datetime) -> PasswordResetToken:
        """Devolve o registro PERSISTIDO (instantes do relógio pós-lock), depois do COMMIT."""
        uid = to_uuid(token.user_id)
        if uid is None:
            raise ValueError("id de usuário inválido")
        ttl = token.expires_at - token.created_at
        with self._ctx.transaction() as conn:
            conn.execute(select(users.c.id).where(users.c.id == uid).with_for_update(key_share=True))
            tx_now = self._ctx.now()                            # relógio DEPOIS do bloqueio
            self._ctx.checkpoint("forgot:locked")
            self._delete_dead_tokens_of(conn, uid, tx_now)      # limpeza mínima e limitada ao usuário
            conn.execute(update(T).where(T.c.user_id == uid, T.c.used_at.is_(None), T.c.invalidated_at.is_(None))
                         .values(invalidated_at=tx_now))
            conn.execute(insert(T).values(token_hash=token.token_hash, user_id=uid, created_at=tx_now,
                                          expires_at=tx_now + ttl))
            self._ctx.checkpoint("forgot:before_commit")
        return PasswordResetToken(token_hash=token.token_hash, user_id=token.user_id, created_at=tx_now,
                                  expires_at=tx_now + ttl)

    @staticmethod
    def _delete_dead_tokens_of(conn: Connection, uid, now: datetime) -> None:
        conn.execute(delete(T).where(T.c.user_id == uid, or_(
            T.c.used_at.is_not(None), T.c.invalidated_at.is_not(None), T.c.expires_at <= now)))

    def is_active(self, token_hash: str, now: datetime) -> bool:
        """Pré-validação BARATA, sem bloqueio (não substitui a revalidação em complete_reset)."""
        with self._ctx.read() as conn:
            row = conn.execute(select(T).where(T.c.token_hash == token_hash)).first()
        return _active(row, now)

    def complete_reset(self, token_hash: str, new_password_hash: str, now: datetime) -> str | None:
        with self._ctx.read() as conn:
            uid = conn.execute(select(T.c.user_id).where(T.c.token_hash == token_hash)).scalar_one_or_none()
        if uid is None:
            return None
        with self._ctx.transaction() as conn:
            user = conn.execute(select(users.c.id).where(users.c.id == uid).with_for_update()).first()
            row = conn.execute(select(T).where(T.c.token_hash == token_hash).with_for_update()).first()
            tx_now = self._ctx.now()                            # relógio DEPOIS dos bloqueios
            self._ctx.checkpoint("reset:locked")
            if user is None or row is None or row.user_id != uid or not _active(row, tx_now):
                return None                                     # revalidação falhou: nada muda
            conn.execute(update(users).where(users.c.id == uid).values(
                password_hash=new_password_hash, credential_version=users.c.credential_version + 1))
            conn.execute(update(T).where(T.c.token_hash == token_hash).values(used_at=tx_now))
            conn.execute(update(T).where(T.c.user_id == uid, T.c.token_hash != token_hash, T.c.used_at.is_(None),
                                         T.c.invalidated_at.is_(None)).values(invalidated_at=tx_now))
            conn.execute(update(auth_sessions).where(auth_sessions.c.user_id == uid,
                                                     auth_sessions.c.revoked_at.is_(None)).values(revoked_at=tx_now))
            self._ctx.checkpoint("reset:before_commit")
        return to_hex(uid)

    def purge_expired(self, now: datetime) -> int:
        with self._ctx.transaction() as conn:
            tx_now = self._ctx.now()
            result = conn.execute(delete(T).where(or_(
                T.c.used_at.is_not(None), T.c.invalidated_at.is_not(None), T.c.expires_at <= tx_now)))
        return result.rowcount
