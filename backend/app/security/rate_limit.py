"""Limitador de taxa simples (janela deslizante) EM MEMÓRIA, com crescimento limitado.

Retenção e limite de memória:
- eventos fora da janela são descartados a cada consulta da chave;
- chaves sem eventos na janela são removidas por varredura periódica (no máximo uma
  vez por janela, pelo relógio injetado) e sempre que o limite de chaves é atingido;
- política explícita para muitas chaves distintas: no máximo `max_keys` chaves são
  rastreadas individualmente. Se, após a varredura, não houver espaço, chaves NOVAS
  passam a compartilhar um balde de transbordo (`OVERFLOW_KEY`) com o mesmo limite.
  Isso mantém a memória limitada SEM apagar contadores de chaves já rastreadas (que
  permitiria a um atacante "zerar" o contador de outra pessoa inundando chaves). Em
  contrapartida, durante uma inundação, chaves novas legítimas também podem ser
  limitadas (degradação segura).

Limitações: vale apenas para o processo atual (não é compartilhado entre workers nem
sobrevive a reinícios) e usa o IP visto pelo servidor, que atrás de proxy reverso
pode ser o do proxy. Para produção, usar um armazenamento compartilhado (ex.: Redis)
e o IP real confiável do cliente.
"""
from __future__ import annotations

import math
import threading
from collections import deque
from datetime import datetime, timedelta

from app.core.clock import Clock

OVERFLOW_KEY = "\x00overflow"


class RateLimiter:
    def __init__(self, max_events: int, window_seconds: int, clock: Clock, *, max_keys: int = 10_000) -> None:
        if max_events < 1 or window_seconds < 1 or max_keys < 1:
            raise ValueError("Parâmetros do limitador devem ser positivos.")
        self._max = max_events
        self._window = timedelta(seconds=window_seconds)
        self._clock = clock
        self._max_keys = max_keys
        self._events: dict[str, deque[datetime]] = {}
        self._lock = threading.Lock()
        self._last_sweep: datetime | None = None

    # ---- internos (com lock) ----
    def _prune(self, q: deque[datetime], now: datetime) -> None:
        while q and now - q[0] >= self._window:
            q.popleft()

    def _sweep(self, now: datetime) -> None:
        for key in list(self._events):
            q = self._events[key]
            self._prune(q, now)
            if not q:
                del self._events[key]
        self._last_sweep = now

    def _individual_keys(self) -> int:
        return len(self._events) - (1 if OVERFLOW_KEY in self._events else 0)

    def _queue(self, key: str, now: datetime, *, create: bool) -> deque[datetime] | None:
        """Fila de eventos da chave. Teto: `max_keys` chaves individuais + 1 balde de transbordo."""
        if self._last_sweep is None or now - self._last_sweep >= self._window:
            self._sweep(now)
        q = self._events.get(key)
        if q is not None:
            self._prune(q, now)
            return q
        if self._individual_keys() >= self._max_keys:
            self._sweep(now)
        if self._individual_keys() < self._max_keys:
            return self._events.setdefault(key, deque()) if create else None
        # Sem espaço: chave nova usa o balde compartilhado de transbordo.
        q = self._events.setdefault(OVERFLOW_KEY, deque()) if create else self._events.get(OVERFLOW_KEY)
        if q is not None:
            self._prune(q, now)
        return q

    def _retry(self, q: deque[datetime], now: datetime) -> int:
        return max(1, math.ceil((q[0] + self._window - now).total_seconds()))

    # ---- API ----
    def retry_after(self, key: str) -> int | None:
        """Segundos até liberar, se o limite foi atingido; senão None. Não registra evento."""
        with self._lock:
            now = self._clock.now()
            q = self._queue(key, now, create=False)
            if q is None or len(q) < self._max:
                return None
            return self._retry(q, now)

    def check_and_hit(self, key: str) -> int | None:
        """Conta o evento se houver espaço (atômico). Retorna Retry-After se bloqueado."""
        with self._lock:
            now = self._clock.now()
            q = self._queue(key, now, create=True)
            assert q is not None
            if len(q) >= self._max:
                return self._retry(q, now)
            q.append(now)
            return None

    def reset(self, key: str) -> None:
        """Zera o contador de uma chave rastreada (nunca o balde de transbordo)."""
        with self._lock:
            if key != OVERFLOW_KEY:
                self._events.pop(key, None)

    def tracked_keys(self) -> int:
        """Número de chaves em memória (inclui o balde de transbordo). Para testes/observabilidade."""
        with self._lock:
            return len(self._events)

    def sweep(self) -> None:
        """Varredura explícita de chaves expiradas."""
        with self._lock:
            self._sweep(self._clock.now())
