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
    def cancel_active(self, timeout: float, *, lock_timeout: float | None = None) -> bool:
        """Um cancelamento da conexão ATIVA, com propriedade confirmada. True se emitido."""
        if not self.capability or timeout <= 0:
            return False
        acquired = self._lock.acquire(timeout=lock_timeout if lock_timeout is not None else timeout)
        if not acquired:
            return False
        try:
            entry = self._entry
            if entry is None or entry.state is not RegistryState.ACTIVE:
                return False
            try:
                entry.driver_connection.cancel_safe(timeout=timeout)   # type: ignore[attr-defined]
            except Exception as exc:                     # só a classe; nunca a mensagem
                logger.warning("recovery_db_cancel_failed error=%s", type(exc).__name__)
                return False
            self.cancel_requests += 1
            return True
        finally:
            self._lock.release()

    @property
    def open_connections(self) -> int:
        with self._lock:
            return self._open

    @property
    def active(self) -> bool:
        with self._lock:
            return self._entry is not None
