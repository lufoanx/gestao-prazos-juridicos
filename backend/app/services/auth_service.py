"""Casos de uso de autenticação e perfil (Etapa 2, armazenamento em memória).

Regras centrais:
- senha com Argon2id; usuário inexistente também paga uma verificação (custo similar);
- login emite access token (JWT curto) + refresh token opaco ligado a uma sessão;
- refresh gira o token a cada uso; reutilização revoga a família (sessão);
- access token só vale se a sessão no servidor estiver ativa (logout/reset revogam);
- recuperação: resposta genérica, token aleatório de uso único, apenas hash guardado;
- redefinição revoga tokens de recuperação pendentes e TODAS as sessões do usuário.
"""
from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import timedelta

from app.core.clock import Clock
from app.core.errors import AppError
from app.core.logging import get_logger
from app.domain.auth import AuthSession, PasswordResetToken, User
from app.repositories.auth import (
    EmailAlreadyRegisteredError,
    PasswordResetRepository,
    RotationResult,
    SessionRepository,
    UserRepository,
)
from app.security.passwords import PasswordHasher
from app.security.rate_limit import RateLimiter
from app.security.tokens import (
    AccessTokenCodec,
    InvalidAccessTokenError,
    hash_opaque_token,
    new_opaque_token,
)
from app.services.password_reset_delivery import PasswordResetDelivery, PasswordResetMessage

logger = get_logger("prazoai.auth")

_BEARER = {"WWW-Authenticate": "Bearer"}


def _unauthorized(code: str = "not_authenticated", message: str = "Não autenticado.") -> AppError:
    return AppError(401, code, message, headers=_BEARER)


@dataclass(frozen=True)
class TokenPair:
    access_token: str
    refresh_token: str
    expires_in: int


@dataclass(frozen=True)
class AuthenticatedUser:
    user: User
    session_id: str


class AuthService:
    def __init__(
        self,
        *,
        users: UserRepository,
        sessions: SessionRepository,
        resets: PasswordResetRepository,
        hasher: PasswordHasher,
        tokens: AccessTokenCodec,
        clock: Clock,
        delivery: PasswordResetDelivery,
        login_limiter: RateLimiter,
        forgot_limiter: RateLimiter,
        refresh_ttl_seconds: int,
        reset_ttl_seconds: int,
    ) -> None:
        self._users = users
        self._sessions = sessions
        self._resets = resets
        self._hasher = hasher
        self._tokens = tokens
        self._clock = clock
        self._delivery = delivery
        self._login_limiter = login_limiter
        self._forgot_limiter = forgot_limiter
        self._refresh_ttl = timedelta(seconds=refresh_ttl_seconds)
        self._reset_ttl = timedelta(seconds=reset_ttl_seconds)

    # --- Cadastro -------------------------------------------------------------
    def register(self, name: str, email: str, password: str) -> User:
        # O hash (caro) é feito fora do lock; a unicidade é garantida atomicamente no repositório.
        user = User(
            id=uuid.uuid4().hex,
            name=name,
            email=email,
            password_hash=self._hasher.hash(password),
            created_at=self._clock.now(),
        )
        try:
            self._users.add(user)
        except EmailAlreadyRegisteredError:
            raise AppError(409, "email_already_registered", "E-mail já cadastrado.") from None
        logger.info("auth_registered user_id=%s", user.id)
        return user

    # --- Login ------------------------------------------------------------------
    def login(self, email: str, password: str, client_ip: str) -> tuple[TokenPair, User]:
        key = f"{client_ip}|{email}"
        # Atômico: conta a tentativa antes de verificar; sucesso zera o contador.
        retry = self._login_limiter.check_and_hit(key)
        if retry is not None:
            raise AppError(
                429, "rate_limited", "Muitas tentativas. Tente novamente mais tarde.",
                headers={"Retry-After": str(retry)},
            )
        user = self._users.get_by_email(email)
        if user is None:
            self._hasher.verify_dummy(password)
            ok = False
        else:
            ok = self._hasher.verify(user.password_hash, password)
        if not ok or user is None:
            logger.info("auth_login_failed")
            raise _unauthorized("invalid_credentials", "E-mail ou senha inválidos.")
        self._login_limiter.reset(key)
        if self._hasher.needs_rehash(user.password_hash):
            self._users.update_password_hash(user.id, self._hasher.hash(password))
        pair = self._start_session(user.id)
        logger.info("auth_login_succeeded user_id=%s", user.id)
        return pair, user

    def _start_session(self, user_id: str) -> TokenPair:
        now = self._clock.now()
        refresh = new_opaque_token()
        session = AuthSession(
            id=uuid.uuid4().hex,
            user_id=user_id,
            created_at=now,
            expires_at=now + self._refresh_ttl,
            current_refresh_hash=hash_opaque_token(refresh),
        )
        self._sessions.add(session)
        return TokenPair(self._tokens.issue(user_id, session.id), refresh, self._tokens.ttl_seconds)

    # --- Refresh ----------------------------------------------------------------
    def refresh(self, refresh_token: str) -> TokenPair:
        new_refresh = new_opaque_token()
        result, session = self._sessions.rotate_refresh(
            hash_opaque_token(refresh_token), hash_opaque_token(new_refresh), self._clock.now()
        )
        if result is RotationResult.REUSED:
            logger.warning("auth_refresh_reuse_detected session_revoked=true")
            raise _unauthorized("invalid_refresh_token", "Refresh token inválido.")
        if result is not RotationResult.ROTATED or session is None:
            raise _unauthorized("invalid_refresh_token", "Refresh token inválido.")
        if self._users.get_by_id(session.user_id) is None:
            self._sessions.revoke(session.id, self._clock.now())
            raise _unauthorized("invalid_refresh_token", "Refresh token inválido.")
        return TokenPair(self._tokens.issue(session.user_id, session.id), new_refresh, self._tokens.ttl_seconds)

    # --- Autenticação de requisição ------------------------------------------------
    def authenticate(self, access_token: str) -> AuthenticatedUser:
        try:
            claims = self._tokens.decode(access_token)
        except InvalidAccessTokenError:
            raise _unauthorized("invalid_token", "Token inválido ou expirado.") from None
        session = self._sessions.get(claims.session_id)
        now = self._clock.now()
        if session is None or session.revoked or session.user_id != claims.user_id or now >= session.expires_at:
            raise _unauthorized("invalid_token", "Token inválido ou expirado.")
        user = self._users.get_by_id(claims.user_id)
        if user is None:
            raise _unauthorized("invalid_token", "Token inválido ou expirado.")
        return AuthenticatedUser(user=user, session_id=session.id)

    def logout(self, auth: AuthenticatedUser) -> None:
        self._sessions.revoke(auth.session_id, self._clock.now())
        logger.info("auth_logout user_id=%s", auth.user.id)

    # --- Perfil -------------------------------------------------------------------
    def update_name(self, user_id: str, name: str) -> User:
        user = self._users.update_name(user_id, name)
        if user is None:
            raise _unauthorized("invalid_token", "Token inválido ou expirado.")
        return user

    # --- Recuperação de senha -------------------------------------------------------
    def forgot_password(self, email: str) -> None:
        """Sempre retorna sem informar se o e-mail existe (limite por e-mail aplicado a todos)."""
        retry = self._forgot_limiter.check_and_hit(email)
        if retry is not None:
            raise AppError(
                429, "rate_limited", "Muitas solicitações. Tente novamente mais tarde.",
                headers={"Retry-After": str(retry)},
            )
        user = self._users.get_by_email(email)
        if user is None:
            return
        now = self._clock.now()
        self._resets.invalidate_all_for_user(user.id, now)  # só o pedido mais recente vale
        token = new_opaque_token()
        record = PasswordResetToken(
            token_hash=hash_opaque_token(token), user_id=user.id, created_at=now, expires_at=now + self._reset_ttl
        )
        self._resets.add(record)
        try:
            self._delivery.send(PasswordResetMessage(user.id, user.email, token, record.expires_at))
        except Exception:  # falha de entrega não pode revelar existência do e-mail
            logger.error("password_reset_delivery_failed")

    def reset_password(self, token: str, new_password: str) -> None:
        # Hash antes de consumir: se algo falhar no hash, o token não é gasto.
        new_hash = self._hasher.hash(new_password)
        now = self._clock.now()
        record = self._resets.consume(hash_opaque_token(token), now)  # atômico: só um vence
        if record is None:
            raise AppError(400, "invalid_reset_token", "Token de recuperação inválido ou expirado.")
        if not self._users.update_password_hash(record.user_id, new_hash):
            raise AppError(400, "invalid_reset_token", "Token de recuperação inválido ou expirado.")
        self._resets.invalidate_all_for_user(record.user_id, now)
        self._sessions.revoke_all_for_user(record.user_id, now)
        logger.info("auth_password_reset user_id=%s sessions_revoked=true", record.user_id)
