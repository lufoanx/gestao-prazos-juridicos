"""Sessões (famílias de refresh) e histórico de hashes usados no PostgreSQL.

Ordem de bloqueios da autenticação: users → password_reset_tokens → auth_sessions (doc 15, §4.2).
- login: users FOR NO KEY UPDATE → sessões do usuário FOR UPDATE (só se o limite exigir remoção);
- rotação/reutilização: users FOR SHARE → sessão FOR UPDATE;
- logout: sessão FOR UPDATE.
Revogações que precisam valer apesar da resposta 401 (credencial alterada, teto, reutilização)
são CONFIRMADAS antes de o serviço responder.
"""
from __future__ import annotations

from datetime import datetime, timedelta

from sqlalchemy import Connection, delete, func, insert, select, update
from sqlalchemy.engine import Row

from app.db.tables import auth_sessions, auth_used_refresh_hashes, users
from app.domain.auth import AuthSession, SessionView, User
from app.repositories.auth import RotationResult
from app.repositories.sql._base import SqlContext, to_hex, to_uuid


def view_from_row(row: Row) -> SessionView:
    return SessionView(id=to_hex(row.id), user_id=to_hex(row.user_id), created_at=row.created_at,
                       expires_at=row.expires_at, credential_version=row.credential_version,
                       rotation_count=row.rotation_count, revoked=row.revoked_at is not None)


class SqlSessionRepository:
    def __init__(self, ctx: SqlContext, *, max_sessions_per_user: int, max_rotations_per_session: int) -> None:
        if max_sessions_per_user < 1 or max_rotations_per_session < 1:
            raise ValueError("limites devem ser >= 1")
        self._ctx = ctx
        self._max_sessions = max_sessions_per_user
        self._max_rotations = max_rotations_per_session

    # ------------------------------------------------------------------ login
    def add_if_credentials_current(self, session: AuthSession) -> bool:
        uid, sid = to_uuid(session.user_id), to_uuid(session.id)
        if uid is None or sid is None:
            return False
        ttl = session.expires_at - session.created_at          # TTL definido pelo serviço
        with self._ctx.transaction() as conn:
            version = conn.execute(
                select(users.c.credential_version).where(users.c.id == uid).with_for_update(key_share=True)
            ).scalar_one_or_none()                              # FOR NO KEY UPDATE
            now = self._ctx.now()                               # relógio DEPOIS do bloqueio
            self._ctx.checkpoint("login:locked")
            if version is None or version != session.credential_version:
                return False                                    # credencial mudou após o Argon2
            self._enforce_session_limit(conn, uid, now)
            conn.execute(insert(auth_sessions).values(
                id=sid, user_id=uid, created_at=now, expires_at=now + ttl,
                current_refresh_hash=session.current_refresh_hash,
                credential_version=version, rotation_count=0,
            ))
            self._ctx.checkpoint("login:before_commit")
        return True

    def _enforce_session_limit(self, conn: Connection, uid, now: datetime) -> None:
        """Política atual: remove expiradas, depois revogadas, depois as mais antigas (com o histórico)."""
        current = conn.execute(select(func.count()).select_from(auth_sessions).where(
            auth_sessions.c.user_id == uid)).scalar_one()
        excess = current - self._max_sessions + 1
        if excess <= 0:
            return
        victims = conn.execute(
            select(auth_sessions.c.id).where(auth_sessions.c.user_id == uid).order_by(
                (auth_sessions.c.expires_at > now).asc(),
                auth_sessions.c.revoked_at.is_(None).asc(),
                auth_sessions.c.created_at.asc(), auth_sessions.c.id.asc(),
            ).limit(excess).with_for_update()
        ).scalars().all()
        conn.execute(delete(auth_sessions).where(auth_sessions.c.id.in_(victims)))   # CASCADE nos hashes

    # ------------------------------------------------------------------ leituras
    def get(self, session_id: str) -> SessionView | None:
        sid = to_uuid(session_id)
        if sid is None:
            return None
        with self._ctx.read() as conn:
            row = conn.execute(select(auth_sessions).where(auth_sessions.c.id == sid)).first()
        return view_from_row(row) if row else None

    def get_with_user(self, session_id: str) -> tuple[SessionView, User] | None:
        """UMA consulta com junção: sessão e usuário do mesmo snapshot."""
        sid = to_uuid(session_id)
        if sid is None:
            return None
        s, u = auth_sessions.alias("s"), users.alias("u")
        with self._ctx.read() as conn:
            row = conn.execute(select(
                s.c.id, s.c.user_id, s.c.created_at, s.c.expires_at, s.c.credential_version, s.c.rotation_count,
                s.c.revoked_at, u.c.name, u.c.email, u.c.password_hash,
                u.c.created_at.label("user_created_at"), u.c.credential_version.label("user_credential_version"),
            ).join(u, u.c.id == s.c.user_id).where(s.c.id == sid)).first()
        if row is None:
            return None
        user = User(id=to_hex(row.user_id), name=row.name, email=row.email, password_hash=row.password_hash,
                    created_at=row.user_created_at, credential_version=row.user_credential_version)
        return view_from_row(row), user

    # ------------------------------------------------------------------ rotação
    def rotate_refresh(self, refresh_hash: str, new_refresh_hash: str, now: datetime
                       ) -> tuple[RotationResult, SessionView | None]:
        """Protocolo do doc 15, §4.3. O `now` recebido é ignorado: vale o relógio pós-lock."""
        with self._ctx.read() as conn:                          # 1. localizar sem bloqueio
            found = conn.execute(select(auth_sessions.c.id, auth_sessions.c.user_id).where(
                auth_sessions.c.current_refresh_hash == refresh_hash)).first()
            used = None
            if found is None:
                used = conn.execute(select(auth_sessions.c.id, auth_sessions.c.user_id).join(
                    auth_used_refresh_hashes, auth_used_refresh_hashes.c.session_id == auth_sessions.c.id,
                ).where(auth_used_refresh_hashes.c.refresh_hash == refresh_hash)).first()
        if found is None:                                       # conexão de leitura já devolvida
            if used is None:
                return RotationResult.INVALID, None
            return self._handle_reuse(used.id, used.user_id), None
        with self._ctx.transaction() as conn:
            version, row, tx_now = self._lock_family(conn, found.user_id, found.id)
            self._ctx.checkpoint("rotate:locked")
            if row is None or version is None:
                return RotationResult.INVALID, None
            if row.current_refresh_hash != refresh_hash:        # outra rotação venceu a corrida
                if self._is_used(conn, row.id, refresh_hash) and tx_now < row.expires_at:
                    self._revoke_locked(conn, row, tx_now)
                    return RotationResult.REUSED, None          # COMMIT da revogação
                return RotationResult.INVALID, None
            if row.revoked_at is not None or tx_now >= row.expires_at:
                return RotationResult.INVALID, None
            if row.credential_version != version:               # credencial alterada: revoga e confirma
                self._revoke_locked(conn, row, tx_now)
                return RotationResult.INVALID, None
            if row.rotation_count >= self._max_rotations:       # teto: revoga, confirma, histórico mantido
                self._revoke_locked(conn, row, tx_now)
                self._ctx.checkpoint("rotate:limit_before_commit")
                return RotationResult.LIMIT_REACHED, None
            conn.execute(insert(auth_used_refresh_hashes).values(
                refresh_hash=refresh_hash, session_id=row.id, used_at=tx_now))
            updated = conn.execute(update(auth_sessions).where(auth_sessions.c.id == row.id).values(
                current_refresh_hash=new_refresh_hash, rotation_count=auth_sessions.c.rotation_count + 1,
            ).returning(auth_sessions)).one()
            self._ctx.checkpoint("rotate:before_commit")
            return RotationResult.ROTATED, view_from_row(updated)

    def _handle_reuse(self, sid, uid) -> RotationResult:
        with self._ctx.transaction() as conn:
            version, row, tx_now = self._lock_family(conn, uid, sid)
            self._ctx.checkpoint("reuse:locked")
            if row is None or version is None or tx_now >= row.expires_at:
                return RotationResult.INVALID
            self._revoke_locked(conn, row, tx_now)              # família comprometida (COMMIT)
            return RotationResult.REUSED

    def _lock_family(self, conn: Connection, uid, sid):
        version = conn.execute(select(users.c.credential_version).where(users.c.id == uid)
                               .with_for_update(read=True)).scalar_one_or_none()      # FOR SHARE
        row = conn.execute(select(auth_sessions).where(auth_sessions.c.id == sid).with_for_update()).first()
        return version, row, self._ctx.now()                    # relógio DEPOIS dos bloqueios

    @staticmethod
    def _is_used(conn: Connection, sid, refresh_hash: str) -> bool:
        return conn.execute(select(auth_used_refresh_hashes.c.refresh_hash).where(
            auth_used_refresh_hashes.c.session_id == sid,
            auth_used_refresh_hashes.c.refresh_hash == refresh_hash)).first() is not None

    @staticmethod
    def _revoke_locked(conn: Connection, row: Row, now: datetime) -> None:
        if row.revoked_at is None:
            conn.execute(update(auth_sessions).where(auth_sessions.c.id == row.id).values(revoked_at=now))

    # ------------------------------------------------------------------ revogação
    def revoke(self, session_id: str, now: datetime) -> bool:
        """Logout idempotente: só a família indicada; histórico preservado."""
        sid = to_uuid(session_id)
        if sid is None:
            return False
        with self._ctx.transaction() as conn:
            row = conn.execute(select(auth_sessions).where(auth_sessions.c.id == sid).with_for_update()).first()
            tx_now = self._ctx.now()
            if row is None or row.revoked_at is not None:
                return False
            self._revoke_locked(conn, row, tx_now)
        return True

    def revoke_all_for_user(self, user_id: str, now: datetime) -> int:
        uid = to_uuid(user_id)
        if uid is None:
            return 0
        with self._ctx.transaction() as conn:
            conn.execute(select(users.c.id).where(users.c.id == uid).with_for_update(key_share=True))
            tx_now = self._ctx.now()
            result = conn.execute(update(auth_sessions).where(
                auth_sessions.c.user_id == uid, auth_sessions.c.revoked_at.is_(None)).values(revoked_at=tx_now))
        return result.rowcount

    def purge_expired(self, now: datetime) -> int:
        """Remove sessões EXPIRADAS com seus hashes usados, pela MESMA rotina limitada da manutenção
        (P5: lotes com SKIP LOCKED, filhos antes, trabalho máximo por chamada; relógio pós-lock).
        Mantido por compatibilidade do contrato; a execução global regular é `app.maintenance`."""
        from app.maintenance.purge import MaintenanceLimits, RetentionPolicy, run_maintenance

        policy = RetentionPolicy(timedelta(0), timedelta(0), timedelta(0))   # não usada nesta categoria
        result = run_maintenance(self._ctx.engine, self._ctx.clock, policy, MaintenanceLimits(),
                                 categories=("sessions",), operation="auth_sessions")
        return result.removed.get("sessions", 0)
