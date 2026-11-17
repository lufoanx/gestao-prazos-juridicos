"""Prazo monotônico de uma operação (E2, correção da auditoria): um único instante-limite fixado na
ENTRADA da operação; cada aquisição de lock, cancelamento e espera recebe só o tempo RESTANTE.

Nada reinicia o orçamento: tentativas sucessivas consomem o mesmo prazo. Com o prazo esgotado, as
aquisições viram tentativas não bloqueantes (`timeout=0`).
"""
from __future__ import annotations

import threading
import time
from collections.abc import Callable


class Deadline:
    def __init__(self, seconds: float | None, monotonic: Callable[[], float] = time.monotonic) -> None:
        self._monotonic = monotonic
        self._end = None if seconds is None else monotonic() + max(0.0, float(seconds))

    @property
    def bounded(self) -> bool:
        return self._end is not None

    def remaining(self, cap: float | None = None) -> float:
        """Tempo restante (≥ 0), opcionalmente limitado por `cap`. Sem prazo: `cap` (ou infinito)."""
        if self._end is None:
            return float("inf") if cap is None else cap
        left = max(0.0, self._end - self._monotonic())
        return left if cap is None else min(cap, left)

    def expired(self) -> bool:
        return self._end is not None and self._monotonic() >= self._end

    def acquire(self, lock: threading.Lock, cap: float | None = None) -> bool:
        """Adquire `lock` esperando no máximo o restante (e `cap`); sem prazo e sem `cap`, espera."""
        wait = self.remaining(cap)
        if wait == float("inf"):
            return lock.acquire()
        return lock.acquire(timeout=wait)
