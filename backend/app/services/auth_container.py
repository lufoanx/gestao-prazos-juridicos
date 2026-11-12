"""Montagem (composição) do módulo de autenticação por instância da aplicação.

Cada `create_app()` cria um container novo: estado, limitadores e segredo efêmero
não são compartilhados entre instâncias (sem variáveis globais mutáveis).
"""
from __future__ import annotations

import secrets
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from app.core.clock import Clock, SystemClock
from app.core.config import Settings
from app.repositories.auth import PasswordResetRepository, SessionRepository, UserRepository
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


class AuthStorageConfigError(RuntimeError):
    """Configuração de armazenamento de autenticação inválida (mensagem sem credenciais)."""


@dataclass
class AuthContainer:
    service: AuthService
    store: MemoryAuthStore | None          # None no modo postgres
    clock: Clock
    ephemeral_secret: bool
    users: UserRepository                  # o MESMO repositório é usado pelo domínio (sem segunda cópia)
    storage: str = "memory"
    engine: Any = None                     # Engine SQLAlchemy no modo postgres (compartilhado com o domínio)
    _closed: bool = field(default=False, repr=False)

    def close(self) -> None:
        """Encerra o engine (todas as conexões do pool). Idempotente; nada a fazer em memória."""
        if self.engine is not None and not self._closed:
            self.engine.dispose()
            self._closed = True


def _memory_repositories(settings: Settings) -> tuple[MemoryAuthStore, UserRepository, SessionRepository,
                                                       PasswordResetRepository]:
    store = MemoryAuthStore(
        max_sessions_per_user=settings.auth_max_sessions_per_user,
        max_rotations_per_session=settings.auth_max_refresh_rotations_per_session,
    )
    return (store, InMemoryUserRepository(store), InMemorySessionRepository(store),
            InMemoryPasswordResetRepository(store))


def _sql_repositories(settings: Settings, clock: Clock, checkpoint: Callable[[str], None] | None):
    """Modo postgres: imports TARDIOS (o modo memory não carrega SQLAlchemy nem psycopg)."""
    from app.db.config import DatabaseConfigError, database_config_from
    from app.db.engine import create_db_engine
    from app.repositories.sql import (
        SchemaNotReadyError,
        SqlContext,
        SqlPasswordResetRepository,
        SqlSessionRepository,
        SqlUserRepository,
        ensure_schema_revision,
    )

    try:
        cfg = database_config_from(settings)
    except DatabaseConfigError as exc:
        raise AuthStorageConfigError(f"STORAGE=postgres: {exc}") from None
    engine = create_db_engine(cfg, application_name="prazoai-backend")
    try:
        ensure_schema_revision(engine)                     # somente leitura; nada é criado
    except SchemaNotReadyError:
        engine.dispose()
        raise
    except Exception as exc:
        engine.dispose()
        cause = getattr(exc, "orig", None) or exc
        raise AuthStorageConfigError(
            f"STORAGE=postgres: não foi possível verificar o esquema em {cfg.describe()} "
            f"({type(cause).__name__})."
        ) from None
    ctx = SqlContext(engine=engine, clock=clock, **({"checkpoint": checkpoint} if checkpoint else {}))
    sessions = SqlSessionRepository(
        ctx, max_sessions_per_user=settings.auth_max_sessions_per_user,
        max_rotations_per_session=settings.auth_max_refresh_rotations_per_session,
    )
    return engine, SqlUserRepository(ctx), sessions, SqlPasswordResetRepository(ctx)


def build_auth_container(
    settings: Settings,
    *,
    clock: Clock | None = None,
    delivery: PasswordResetDelivery | None = None,
    password_hasher: PasswordHasher | None = None,
    sql_checkpoint: Callable[[str], None] | None = None,
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
    store: MemoryAuthStore | None = None
    engine = None
    if settings.storage == "postgres":
        engine, users, sessions, resets = _sql_repositories(settings, clock, sql_checkpoint)
    else:
        store, users, sessions, resets = _memory_repositories(settings)

    def limiter(max_events: int, window: int) -> RateLimiter:
        return RateLimiter(max_events, window, clock, max_keys=settings.auth_rate_limit_max_keys)

    service = AuthService(
        users=users,
        sessions=sessions,
        resets=resets,
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
    return AuthContainer(service=service, store=store, clock=clock, ephemeral_secret=ephemeral, users=users,
                         storage=settings.storage, engine=engine)
