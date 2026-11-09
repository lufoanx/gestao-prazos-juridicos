"""Montagem (composição) do módulo de autenticação por instância da aplicação.

Cada `create_app()` cria um container novo: estado, limitadores e segredo efêmero
não são compartilhados entre instâncias (sem variáveis globais mutáveis).
"""
from __future__ import annotations

import secrets
from dataclasses import dataclass

from app.core.clock import Clock, SystemClock
from app.core.config import Settings
from app.repositories.memory import (
    InMemoryPasswordResetRepository,
    InMemorySessionRepository,
    InMemoryUserRepository,
    MemoryAuthStore,
)
from app.security.passwords import PasswordHasher
from app.security.rate_limit import RateLimiter
from app.security.tokens import AccessTokenCodec
from app.services.auth_service import AuthService
from app.services.password_reset_delivery import NoopPasswordResetDelivery, PasswordResetDelivery


class InMemoryAuthBlockedError(RuntimeError):
    """Armazenamento de autenticação em memória não é permitido em production."""


@dataclass
class AuthContainer:
    service: AuthService
    store: MemoryAuthStore
    clock: Clock
    ephemeral_secret: bool


def build_auth_container(
    settings: Settings,
    *,
    clock: Clock | None = None,
    delivery: PasswordResetDelivery | None = None,
    password_hasher: PasswordHasher | None = None,
) -> AuthContainer:
    if settings.auth_storage == "memory" and settings.is_production:
        raise InMemoryAuthBlockedError(
            "AUTH_STORAGE=memory é bloqueado em ENVIRONMENT=production: os dados se perdem ao reiniciar e "
            "não funcionam com múltiplos workers. Use AUTH_ENABLED=false ou um armazenamento persistente."
        )
    if settings.auth_jwt_secret is not None:
        secret, ephemeral = settings.auth_jwt_secret.get_secret_value(), False
    elif settings.environment in {"development", "test"}:
        secret, ephemeral = secrets.token_urlsafe(64), True
    else:
        raise ValueError(f"AUTH_JWT_SECRET é obrigatório em ENVIRONMENT={settings.environment}.")

    clock = clock or SystemClock()
    store = MemoryAuthStore(
        max_sessions_per_user=settings.auth_max_sessions_per_user,
        max_rotations_per_session=settings.auth_max_refresh_rotations_per_session,
    )

    def limiter(max_events: int, window: int) -> RateLimiter:
        return RateLimiter(max_events, window, clock, max_keys=settings.auth_rate_limit_max_keys)

    service = AuthService(
        users=InMemoryUserRepository(store),
        sessions=InMemorySessionRepository(store),
        resets=InMemoryPasswordResetRepository(store),
        hasher=password_hasher or PasswordHasher(),
        tokens=AccessTokenCodec(
            secret, settings.auth_jwt_issuer, settings.auth_jwt_audience, settings.auth_access_token_ttl_seconds, clock
        ),
        clock=clock,
        delivery=delivery or NoopPasswordResetDelivery(),
        login_limiter=limiter(settings.auth_login_max_failures, settings.auth_login_window_seconds),
        forgot_limiter=limiter(settings.auth_forgot_max_requests, settings.auth_forgot_window_seconds),
        register_limiter=limiter(settings.auth_register_max_requests, settings.auth_register_window_seconds),
        reset_limiter=limiter(settings.auth_reset_max_requests, settings.auth_reset_window_seconds),
        refresh_ttl_seconds=settings.auth_refresh_token_ttl_seconds,
        reset_ttl_seconds=settings.auth_password_reset_ttl_seconds,
    )
    return AuthContainer(service=service, store=store, clock=clock, ephemeral_secret=ephemeral)
