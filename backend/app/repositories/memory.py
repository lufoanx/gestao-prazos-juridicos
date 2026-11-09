"""Repositórios EM MEMÓRIA (Etapa 2).

ATENÇÃO — não é persistência de produção:
- os dados se perdem ao reiniciar o processo;
- cada processo/worker tem sua própria cópia (incompatível com múltiplos workers);
- o estado pertence a uma instância de `MemoryAuthStore`, criada por `create_app`,
  e nunca a variáveis globais do módulo.

Consistência: todas as leituras e escritas usam um único `threading.RLock` por
instância, compartilhado pelos três repositórios. Operações compostas (criar sessão
condicionada à versão da credencial, rehash condicional, emissão de token de
recuperação substituindo o ativo e redefinição completa) acontecem inteiras dentro do
lock. O lock NUNCA é mantido durante o cálculo de Argon2 (feito antes, no serviço).

Retenção: sessões expiradas e tokens de recuperação inativos são removidos
periodicamente (a cada `purge_interval` do relógio) e sob demanda (`purge_expired`).
Sessões revogadas permanecem até a expiração absoluta, para que a reutilização de um
refresh token girado continue sendo reconhecida durante toda a validade da sessão.

Histórico de rotações finito: cada sessão gira no máximo `max_rotations_per_session`
vezes. Depois disso, o próximo refresh ENCERRA a sessão (novo login obrigatório). Assim,
o histórico de hashes usados de uma sessão — e sua parcela do índice global — nunca
passa do teto, e nenhum hash é descartado enquanto a família existir.
Memória máxima de hashes por usuário ≈ max_sessions_per_user × (max_rotations + 1).
"""
from __future__ import annotations

import threading
from dataclasses import replace
from datetime import datetime, timedelta

from app.domain.auth import AuthSession, PasswordResetToken, SessionView, User
from app.repositories.auth import EmailAlreadyRegisteredError, RotationResult


class MemoryAuthStore:
    """Agrupa o estado e o lock de uma instância da aplicação."""

    def __init__(
        self,
        *,
        max_sessions_per_user: int = 10,
        max_rotations_per_session: int = 1000,
        purge_interval_seconds: int = 60,
    ) -> None:
        if max_sessions_per_user < 1:
            raise ValueError("max_sessions_per_user deve ser >= 1")
        if max_rotations_per_session < 1:
            raise ValueError("max_rotations_per_session deve ser >= 1")
        self.lock = threading.RLock()
        self.max_sessions_per_user = max_sessions_per_user
        self.max_rotations_per_session = max_rotations_per_session
        self.purge_interval = timedelta(seconds=purge_interval_seconds)
        self.last_purge: datetime | None = None
        self.users_by_id: dict[str, User] = {}
        self.user_id_by_email: dict[str, str] = {}
        self.sessions: dict[str, AuthSession] = {}
        self.session_ids_by_user: dict[str, set[str]] = {}
        self.session_by_current_hash: dict[str, str] = {}
        self.session_by_used_hash: dict[str, str] = {}
        self.reset_tokens: dict[str, PasswordResetToken] = {}

    # ---- utilitários internos (chamar SEMPRE com o lock adquirido) ----
    def delete_session_locked(self, session_id: str) -> None:
        s = self.sessions.pop(session_id, None)
        if s is None:
            return
        if self.session_by_current_hash.get(s.current_refresh_hash) == session_id:
            del self.session_by_current_hash[s.current_refresh_hash]
        for h in s.used_refresh_hashes:
            if self.session_by_used_hash.get(h) == session_id:
                del self.session_by_used_hash[h]
        ids = self.session_ids_by_user.get(s.user_id)
        if ids is not None:
            ids.discard(session_id)
            if not ids:
                del self.session_ids_by_user[s.user_id]

    def revoke_session_locked(self, session_id: str, now: datetime) -> bool:
        s = self.sessions.get(session_id)
        if s is None or s.revoked:
            return False
        s.revoked_at = now
        # O refresh atual deixa de girar; o histórico de usados é mantido (detecção de reuso).
        if self.session_by_current_hash.get(s.current_refresh_hash) == session_id:
            del self.session_by_current_hash[s.current_refresh_hash]
        return True

    def purge_sessions_locked(self, now: datetime) -> int:
        expired = [sid for sid, s in self.sessions.items() if now >= s.expires_at]
        for sid in expired:
            self.delete_session_locked(sid)
        return len(expired)

    def purge_reset_tokens_locked(self, now: datetime) -> int:
        dead = [
            h for h, t in self.reset_tokens.items()
            if t.used_at is not None or t.invalidated_at is not None or now >= t.expires_at
        ]
        for h in dead:
            del self.reset_tokens[h]
        return len(dead)

    def maybe_purge_locked(self, now: datetime) -> None:
        if self.last_purge is None or now - self.last_purge >= self.purge_interval:
            self.purge_sessions_locked(now)
            self.purge_reset_tokens_locked(now)
            self.last_purge = now


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

    def update_password_hash_if_version(self, user_id: str, password_hash: str, expected_version: int) -> bool:
        with self._s.lock:
            u = self._s.users_by_id.get(user_id)
            if u is None or u.credential_version != expected_version:
                return False
            u.password_hash = password_hash
            return True


class InMemorySessionRepository:
    def __init__(self, store: MemoryAuthStore) -> None:
        self._s = store

    def add_if_credentials_current(self, session: AuthSession) -> bool:
        s = self._s
        with s.lock:
            s.maybe_purge_locked(session.created_at)
            user = s.users_by_id.get(session.user_id)
            if user is None or user.credential_version != session.credential_version:
                return False
            # Limite de sessões por usuário: remove as mais antigas (expiradas primeiro).
            ids = s.session_ids_by_user.setdefault(session.user_id, set())
            if len(ids) >= s.max_sessions_per_user:
                ordered = sorted(
                    (s.sessions[i] for i in ids),
                    key=lambda x: (session.created_at < x.expires_at, not x.revoked, x.created_at),
                )
                for old in ordered[: len(ids) - s.max_sessions_per_user + 1]:
                    s.delete_session_locked(old.id)
                ids = s.session_ids_by_user.setdefault(session.user_id, set())
            stored = replace(session, used_refresh_hashes=set(session.used_refresh_hashes))
            s.sessions[session.id] = stored
            ids.add(session.id)
            s.session_by_current_hash[session.current_refresh_hash] = session.id
            return True

    def get(self, session_id: str) -> SessionView | None:
        with self._s.lock:
            s = self._s.sessions.get(session_id)
            return s.view() if s else None  # sem copiar o histórico de hashes

    def rotate_refresh(
        self, refresh_hash: str, new_refresh_hash: str, now: datetime
    ) -> tuple[RotationResult, SessionView | None]:
        s = self._s
        with s.lock:
            sid = s.session_by_current_hash.get(refresh_hash)
            if sid is None:
                reused_sid = s.session_by_used_hash.get(refresh_hash)
                if reused_sid is not None:
                    reused = s.sessions.get(reused_sid)
                    if reused is not None and now < reused.expires_at:
                        # Reutilização de token já girado → família comprometida.
                        s.revoke_session_locked(reused_sid, now)
                        return RotationResult.REUSED, None
                return RotationResult.INVALID, None
            session = s.sessions[sid]
            if session.revoked or now >= session.expires_at:
                return RotationResult.INVALID, None
            user = s.users_by_id.get(session.user_id)
            if user is None or user.credential_version != session.credential_version:
                s.revoke_session_locked(sid, now)
                return RotationResult.INVALID, None
            if session.rotation_count >= s.max_rotations_per_session:
                # Teto atingido: encerra a família (exige novo login). O histórico é mantido
                # até a expiração para continuar detectando reutilização de tokens antigos.
                s.revoke_session_locked(sid, now)
                return RotationResult.LIMIT_REACHED, None
            del s.session_by_current_hash[refresh_hash]
            session.used_refresh_hashes.add(refresh_hash)
            s.session_by_used_hash[refresh_hash] = sid
            session.current_refresh_hash = new_refresh_hash
            s.session_by_current_hash[new_refresh_hash] = sid
            return RotationResult.ROTATED, session.view()

    def revoke(self, session_id: str, now: datetime) -> bool:
        with self._s.lock:
            return self._s.revoke_session_locked(session_id, now)

    def revoke_all_for_user(self, user_id: str, now: datetime) -> int:
        with self._s.lock:
            ids = list(self._s.session_ids_by_user.get(user_id, ()))
            return sum(1 for sid in ids if self._s.revoke_session_locked(sid, now))

    def purge_expired(self, now: datetime) -> int:
        with self._s.lock:
            return self._s.purge_sessions_locked(now)


class InMemoryPasswordResetRepository:
    def __init__(self, store: MemoryAuthStore) -> None:
        self._s = store

    @staticmethod
    def _active(t: PasswordResetToken | None, now: datetime) -> bool:
        return t is not None and t.used_at is None and t.invalidated_at is None and now < t.expires_at

    def _invalidate_user_locked(self, user_id: str, now: datetime, keep: str | None = None) -> None:
        for h, t in self._s.reset_tokens.items():
            if h != keep and t.user_id == user_id and t.used_at is None and t.invalidated_at is None:
                t.invalidated_at = now

    def issue_replacing_active(self, token: PasswordResetToken, now: datetime) -> None:
        with self._s.lock:
            self._s.maybe_purge_locked(now)
            self._invalidate_user_locked(token.user_id, now)
            self._s.reset_tokens[token.token_hash] = replace(token)

    def is_active(self, token_hash: str, now: datetime) -> bool:
        with self._s.lock:
            return self._active(self._s.reset_tokens.get(token_hash), now)

    def complete_reset(self, token_hash: str, new_password_hash: str, now: datetime) -> str | None:
        s = self._s
        with s.lock:
            t = s.reset_tokens.get(token_hash)
            if t is None or not self._active(t, now):
                return None
            user = s.users_by_id.get(t.user_id)
            if user is None:
                t.invalidated_at = now
                return None
            t.used_at = now
            user.password_hash = new_password_hash
            user.credential_version += 1
            self._invalidate_user_locked(user.id, now, keep=token_hash)
            for sid in list(s.session_ids_by_user.get(user.id, ())):
                s.revoke_session_locked(sid, now)
            return user.id

    def purge_expired(self, now: datetime) -> int:
        with self._s.lock:
            return self._s.purge_reset_tokens_locked(now)
