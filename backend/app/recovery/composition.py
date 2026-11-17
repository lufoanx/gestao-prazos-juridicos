"""Montagem do RecoveryDispatcher por instância da aplicação (E2, doc 21).

- Entrega: a injetada (testes) ou, com `EMAIL_TRANSPORT=smtp`, composer + transporte da E1. Com
  `disabled` (padrão) não há despachante nem worker: `status` → false e `forgot-password` → 503.
- Repositórios do worker: em memória, os MESMOS da autenticação; em PostgreSQL, os repositórios SQL
  existentes sobre uma conexão EXCLUSIVA (engine próprio com `NullPool`, limites próprios, registro de
  cancelamento). O pool da API nunca é usado pelo worker.
- A thread só é criada em `start()`, chamado pelo `lifespan` (não na importação nem na composição).
"""
from __future__ import annotations

import time
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from app.core.config import Settings
from app.recovery.cancel import CancelRegistry
from app.recovery.dispatcher import DispatcherState, RecoveryDispatcher
from app.recovery.processor import RecoveryProcessor


@dataclass
class RecoveryRuntime:
    dispatcher: RecoveryDispatcher
    worker_engine: Any = None                 # engine exclusivo (NullPool) no modo postgres
    registry: CancelRegistry | None = None
    _closed: bool = field(default=False, repr=False)

    @property
    def available(self) -> bool:
        return self.dispatcher.available

    def start(self) -> None:
        self.dispatcher.start()

    def stop(self) -> DispatcherState:
        """Protocolo de encerramento (§4.7). O engine exclusivo só é descartado no caminho limpo."""
        state = self.dispatcher.stop()
        if state is DispatcherState.STOPPED_CLEAN and self.worker_engine is not None and not self._closed:
            self.worker_engine.dispose()
            self._closed = True
        return state


def _build_delivery(settings: Settings):
    if settings.email_transport != "smtp":
        return None
    from app.email.composer import PasswordResetComposer
    from app.email.config import EmailConfig
    from app.email.transport import build_email_transport
    from app.recovery.delivery import TransportPasswordResetDelivery

    origin = EmailConfig.from_settings(settings).origin
    return TransportPasswordResetDelivery(PasswordResetComposer(origin, settings.deadlines_timezone),
                                          build_email_transport(settings))


def build_recovery(settings: Settings, auth, *, delivery=None,
                   sql_checkpoint: Callable[[str], None] | None = None,
                   monotonic: Callable[[], float] = time.monotonic,
                   cancel_capability: bool | None = None,
                   registry_hook: Callable[[str], None] | None = None) -> RecoveryRuntime | None:
    """`None` quando a recuperação está desabilitada (sem entrega disponível)."""
    if delivery is None:
        delivery = _build_delivery(settings)
    if delivery is None or not bool(getattr(delivery, "available", True)):
        return None
    worker_engine = None
    registry: CancelRegistry | None = None
    if auth.storage == "postgres":
        from app.db.config import database_config_from
        from app.recovery.cancel import cancel_with_timeout_supported
        from app.recovery.worker_db import (
            ExclusiveSqlContext,
            create_worker_engine,
        )
        from app.repositories.sql import SqlPasswordResetRepository, SqlUserRepository

        capability = cancel_with_timeout_supported() if cancel_capability is None else cancel_capability
        registry = CancelRegistry(capability=capability, **({"hook": registry_hook} if registry_hook else {}))
        worker_engine = create_worker_engine(database_config_from(settings))
        ctx = ExclusiveSqlContext(
            worker_engine, auth.clock, registry, lock_timeout_ms=settings.recovery_db_lock_timeout_ms,
            statement_timeout_ms=settings.recovery_db_statement_timeout_ms,
            **({"checkpoint": sql_checkpoint} if sql_checkpoint else {}),
        )
        users, resets = SqlUserRepository(ctx), SqlPasswordResetRepository(ctx)
    else:
        users, resets = auth.users, auth.resets
    processor = RecoveryProcessor(users=users, resets=resets, clock=auth.clock,
                                  reset_ttl_seconds=settings.auth_password_reset_ttl_seconds, delivery=delivery)
    dispatcher = RecoveryDispatcher(
        processor, delivery, queue_max=settings.recovery_queue_max,
        max_wait_seconds=settings.recovery_queue_max_wait_seconds,
        shutdown_grace_seconds=settings.recovery_shutdown_grace_seconds, cancel_registry=registry,
        monotonic=monotonic,
    )
    return RecoveryRuntime(dispatcher=dispatcher, worker_engine=worker_engine, registry=registry)
