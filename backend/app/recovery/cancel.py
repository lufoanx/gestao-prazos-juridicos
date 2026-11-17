"""Registro de cancelamento da conexão exclusiva do worker (doc 21, §4.8). Sem SQLAlchemy: importável
no modo memória sem carregar o banco.

O worker publica `{geração, conexão, ATIVA}` antes do primeiro comando; o encerramento só chama
`cancel_safe(timeout)` com o registro ATIVO e AINDA segurando o lock; o worker marca LIBERANDO e remove
o registro sob o mesmo lock ANTES de fechar a conexão. Sem a capacidade (libpq < 17 ou sem
`cancel_safe`), nenhum cancelamento ativo é feito.
"""
from __future__ import annotations

import logging
import threading
from collections.abc import Callable
from dataclasses import dataclass
from enum import Enum

from app.core.deadline import Deadline

logger = logging.getLogger("prazoai.recovery")

LIBPQ_CANCEL_TIMEOUT_MIN = 170000


def _no_hook(_name: str) -> None:
    return None


def cancel_with_timeout_supported() -> bool:
    """libpq ≥ 17 E `Connection.cancel_safe` presente (capacidade real do cliente)."""
    try:
        import psycopg
    except ImportError:                                   # pragma: no cover - dependência fixada
        return False
    try:
        version = psycopg.pq.version()
    except Exception:                                     # pragma: no cover - defensivo
        return False
    return version >= LIBPQ_CANCEL_TIMEOUT_MIN and hasattr(psycopg.Connection, "cancel_safe")


class CancelOutcome(str, Enum):
    ISSUED = "issued"                     # cancel_safe chamado com propriedade confirmada
    NO_ACTIVE = "no_active"               # nenhuma conexão ATIVA (nada a cancelar)
    NO_CAPABILITY = "no_capability"       # libpq < 17 / sem cancel_safe: nenhum cancelamento ativo
    LOCK_TIMEOUT = "lock_timeout"         # lock do registro não obtido no prazo: propriedade não confirmada
    BUDGET_EXHAUSTED = "budget_exhausted"  # sem tempo restante para o driver
    FAILED = "failed"                     # o driver falhou (só a classe vai ao log)


@dataclass(frozen=True)
class RegistrySnapshot:
    active: bool
    open_connections: int


class RegistryState(str, Enum):
    ACTIVE = "ativa"
    RELEASING = "liberando"


@dataclass
class _Entry:
    generation: int
    driver_connection: object
    state: RegistryState


class CancelRegistry:
    """Quem pode cancelar o quê: só a conexão publicada como ATIVA, sob o lock do registro."""

    def __init__(self, *, capability: bool, hook: Callable[[str], None] = _no_hook) -> None:
        self._lock = threading.Lock()
        self._entry: _Entry | None = None
        self._generation = 0
        self._open = 0                     # conexões exclusivas ainda não fechadas
        self.capability = capability
        self.cancel_requests = 0           # cancelamentos efetivamente emitidos (observabilidade/testes)
        self._hook = hook

    # -------------------------------------------------- lado do worker
    def opened(self) -> None:
        with self._lock:
            self._open += 1

    def closed(self) -> None:
        with self._lock:
            self._open -= 1

    def publish(self, driver_connection: object) -> int:
        with self._lock:
            self._generation += 1
            self._entry = _Entry(self._generation, driver_connection, RegistryState.ACTIVE)
            return self._generation

    def withdraw(self, generation: int) -> None:
        """LIBERANDO → removido, sob o lock (espera um `cancel_safe` em curso terminar)."""
        with self._lock:
            if self._entry is not None and self._entry.generation == generation:
                self._entry.state = RegistryState.RELEASING
                self._entry = None
        self._hook("recovery:withdrawn")                 # depois da retirada, antes do fechamento

    # -------------------------------------------------- lado do encerramento
    # Correção da auditoria: TODAS as operações do encerramento recebem um `Deadline` fixado na entrada
    # do `stop()`. A aquisição do lock consome esse prazo, e o driver recebe só o que RESTA depois dela.
    def cancel_active(self, deadline: Deadline, *, lock_cap: float | None = None,
                      driver_cap: float = 1.0) -> CancelOutcome:
        """No máximo UM cancelamento da conexão ATIVA, com propriedade confirmada (lock retido durante
        `cancel_safe`). Sem capacidade: nada é feito, nem bloqueante."""
        if not self.capability:
            return CancelOutcome.NO_CAPABILITY
        if deadline.expired():
            return CancelOutcome.BUDGET_EXHAUSTED
        if not deadline.acquire(self._lock, lock_cap):
            return CancelOutcome.LOCK_TIMEOUT
        try:
            entry = self._entry
            if entry is None or entry.state is not RegistryState.ACTIVE:
                return CancelOutcome.NO_ACTIVE
            driver_timeout = deadline.remaining(driver_cap)      # descontado o tempo gasto no lock
            if driver_timeout <= 0:
                return CancelOutcome.BUDGET_EXHAUSTED
            try:
                entry.driver_connection.cancel_safe(timeout=driver_timeout)   # type: ignore[attr-defined]
            except Exception as exc:                     # só a classe; nunca a mensagem
                logger.warning("recovery_db_cancel_failed error=%s", type(exc).__name__)
                return CancelOutcome.FAILED
            self.cancel_requests += 1
            return CancelOutcome.ISSUED
        finally:
            self._lock.release()

    def snapshot(self, deadline: Deadline) -> RegistrySnapshot | None:
        """Estado (registro ativo, conexões abertas) lido dentro do prazo; None = não confirmado."""
        if not deadline.acquire(self._lock):
            return None
        try:
            return RegistrySnapshot(active=self._entry is not None, open_connections=self._open)
        finally:
            self._lock.release()

    # Leituras sem prazo: só para testes e observação fora do encerramento.
    @property
    def open_connections(self) -> int:
        with self._lock:
            return self._open

    @property
    def active(self) -> bool:
        with self._lock:
            return self._entry is not None
