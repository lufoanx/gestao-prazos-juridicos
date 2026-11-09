"""Repositórios EM MEMÓRIA (Etapa 2).

ATENÇÃO — não é persistência de produção:
- os dados se perdem ao reiniciar o processo;
- cada processo/worker tem sua própria cópia (incompatível com múltiplos workers);
- o estado pertence a uma instância de `MemoryAuthStore`, criada por `create_app`,
  e nunca a variáveis globais do módulo.

Atomicidade: todas as operações de leitura/escrita usam um único `threading.RLock`
compartilhado pelos três repositórios da mesma instância.
"""
from __future__ import annotations

import threading
from dataclasses import replace
from datetime import datetime

from app.domain.auth import AuthSession, PasswordResetToken, User
from app.repositories.auth import EmailAlreadyRegisteredError, RotationResult


class MemoryAuthStore:
    """Agrupa o estado e o lock de uma instância da aplicação."""

    def __init__(self) -> None:
        self.lock = threading.RLock()
        self.users_by_id: dict[str, User] = {}
        self.user_id_by_email: dict[str, str] = {}
        self.sessions: dict[str, AuthSession] = {}
        self.session_by_current_hash: dict[str, str] = {}
        self.session_by_used_hash: dict[str, str] = {}
        self.reset_tokens: dict[str, PasswordResetToken] = {}


class InMemoryUserRepository:
    def __init__(self, store: MemoryAuthStore) -> None:
        self._s = store

    def add(self, user: User) -> None:
        with self._s.lock:
            if user.email in self._s.user_id_by_email:
                raise EmailAlreadyRegisteredError()
            self._s.users_by_id[user.id] = replace(user)
            self._s.user_id_by_email[user.email] = user.id

    def get_by_id(self, user_id: str) -> User | None:
        with self._s.lock:
            u = self._s.users_by_id.get(user_id)
            return replace(u) if u else None

    def get_by_email(self, email: str) -> User | None:
        with self._s.lock:
            uid = self._s.user_id_by_email.get(email)
            u = self._s.users_by_id.get(uid) if uid else None
            return replace(u) if u else None

    def update_name(self, user_id: str, name: str) -> User | None:
        with self._s.lock:
            u = self._s.users_by_id.get(user_id)
            if u is None:
                return None
            u.name = name
            return replace(u)

    def update_password_hash(self, user_id: str, password_hash: str) -> bool:
        with self._s.lock:
            u = self._s.users_by_id.get(user_id)
            if u is None:
                return False
            u.password_hash = password_hash
            return True


class InMemorySessionRepository:
    def __init__(self, store: MemoryAuthStore) -> None:
        self._s = store

    def add(self, session: AuthSession) -> None:
        with self._s.lock:
            self._s.sessions[session.id] = session
            self._s.session_by_current_hash[session.current_refresh_hash] = session.id

    def get(self, session_id: str) -> AuthSession | None:
        with self._s.lock:
            s = self._s.sessions.get(session_id)
            return replace(s, used_refresh_hashes=set(s.used_refresh_hashes)) if s else None

    def rotate_refresh(
        self, refresh_hash: str, new_refresh_hash: str, now: datetime
    ) -> tuple[RotationResult, AuthSession | None]:
        with self._s.lock:
            sid = self._s.session_by_current_hash.get(refresh_hash)
            if sid is None:
                reused_sid = self._s.session_by_used_hash.get(refresh_hash)
                if reused_sid is not None:
                    # Reutilização de token já girado → família comprometida.
                    self._revoke_locked(reused_sid, now)
                    return RotationResult.REUSED, None
                return RotationResult.INVALID, None
            session = self._s.sessions[sid]
            if session.revoked or now >= session.expires_at:
                return RotationResult.INVALID, None
            del self._s.session_by_current_hash[refresh_hash]
            session.used_refresh_hashes.add(refresh_hash)
            self._s.session_by_used_hash[refresh_hash] = sid
            session.current_refresh_hash = new_refresh_hash
            self._s.session_by_current_hash[new_refresh_hash] = sid
            return RotationResult.ROTATED, replace(session, used_refresh_hashes=set(session.used_refresh_hashes))

    def _revoke_locked(self, session_id: str, now: datetime) -> bool:
        session = self._s.sessions.get(session_id)
        if session is None or session.revoked:
            return False
        session.revoked_at = now
        self._s.session_by_current_hash.pop(session.current_refresh_hash, None)
        return True

    def revoke(self, session_id: str, now: datetime) -> bool:
        with self._s.lock:
            return self._revoke_locked(session_id, now)

    def revoke_all_for_user(self, user_id: str, now: datetime) -> int:
        with self._s.lock:
            ids = [s.id for s in self._s.sessions.values() if s.user_id == user_id]
            return sum(1 for sid in ids if self._revoke_locked(sid, now))


class InMemoryPasswordResetRepository:
    def __init__(self, store: MemoryAuthStore) -> None:
        self._s = store

    def add(self, token: PasswordResetToken) -> None:
        with self._s.lock:
            self._s.reset_tokens[token.token_hash] = token

    def consume(self, token_hash: str, now: datetime) -> PasswordResetToken | None:
        with self._s.lock:
            t = self._s.reset_tokens.get(token_hash)
            if t is None or t.used_at is not None or t.invalidated_at is not None or now >= t.expires_at:
                return None
            t.used_at = now
            return replace(t)

    def invalidate_all_for_user(self, user_id: str, now: datetime) -> int:
        with self._s.lock:
            n = 0
            for t in self._s.reset_tokens.values():
                if t.user_id == user_id and t.used_at is None and t.invalidated_at is None:
                    t.invalidated_at = now
                    n += 1
            return n
