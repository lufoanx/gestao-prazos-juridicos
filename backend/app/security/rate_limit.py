"""Limitador de taxa simples (janela deslizante) EM MEMÓRIA.

Limitações: vale apenas para o processo atual (não é compartilhado entre workers nem
sobrevive a reinícios) e usa o IP visto pelo servidor, que atrás de proxy reverso
pode ser o do proxy. Para produção, usar um armazenamento compartilhado (ex.: Redis)
e o IP real confiável do cliente.
"""
from __future__ import annotations

import math
import threading
from collections import deque
from datetime import timedelta

from app.core.clock import Clock


class RateLimiter:
    def __init__(self, max_events: int, window_seconds: int, clock: Clock) -> None:
        self._max = max_events
        self._window = timedelta(seconds=window_seconds)
        self._clock = clock
        self._events: dict[str, deque] = {}
        self._lock = threading.Lock()

    def _prune(self, key: str):
        now = self._clock.now()
        q = self._events.setdefault(key, deque())
        while q and now - q[0] >= self._window:
            q.popleft()
        return now, q

    def retry_after(self, key: str) -> int | None:
        """Segundos até liberar, se o limite foi atingido; senão None."""
        with self._lock:
            now, q = self._prune(key)
            if len(q) < self._max:
                return None
            return max(1, math.ceil((q[0] + self._window - now).total_seconds()))

    def hit(self, key: str) -> None:
        with self._lock:
            now, q = self._prune(key)
            q.append(now)

    def check_and_hit(self, key: str) -> int | None:
        """Conta o evento se houver espaço (atômico). Retorna Retry-After se bloqueado."""
        with self._lock:
            now, q = self._prune(key)
            if len(q) >= self._max:
                return max(1, math.ceil((q[0] + self._window - now).total_seconds()))
            q.append(now)
            return None

    def reset(self, key: str) -> None:
        with self._lock:
            self._events.pop(key, None)
