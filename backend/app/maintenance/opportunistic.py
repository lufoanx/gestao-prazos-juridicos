"""Execução OPORTUNISTA da manutenção (P5), por processo.

- No máximo UMA execução por intervalo e por processo, mesmo com requisições concorrentes
  (reivindicação sob `threading.Lock` não bloqueante; o instante da reivindicação conta como a
  última execução, inclusive se ela falhar — nova tentativa só no próximo intervalo).
- Roda como tarefa de segundo plano DEPOIS da resposta (a conexão da operação de negócio já foi
  devolvida e a transação dela já terminou); usa conexões e transações próprias.
- Trabalho limitado (`MAINTENANCE_OPPORTUNISTIC_MAX_BATCHES`); nada de agendador permanente.
- Justiça: um CURSOR por processo guarda de qual categoria a próxima execução começa (ver
  `run_maintenance`); após reinício, o cursor recomeça num deslocamento derivado do relógio (janela do
  intervalo), não sempre na primeira categoria.
- Uma falha da manutenção nunca propaga: não altera nem desfaz o resultado já confirmado.
"""
from __future__ import annotations

import logging
import threading
from collections.abc import Callable
from datetime import datetime, timedelta

from sqlalchemy import Engine

from app.core.clock import Clock
from app.maintenance.purge import (
    AUTH_CATEGORIES,
    DOMAIN_CATEGORIES,
    MaintenanceLimits,
    MaintenanceResult,
    RetentionPolicy,
    run_maintenance,
)

CATEGORY_ORDER = (*DOMAIN_CATEGORIES, *AUTH_CATEGORIES)

logger = logging.getLogger("prazoai.maintenance")


class OpportunisticMaintenance:
    def __init__(self, engine: Engine, clock: Clock, policy: RetentionPolicy, limits: MaintenanceLimits,
                 interval_seconds: int, checkpoint: Callable[[str], None] | None = None) -> None:
        self._engine, self._clock, self._policy, self._limits = engine, clock, policy, limits
        self._interval = timedelta(seconds=interval_seconds)
        self._checkpoint = checkpoint
        self._lock = threading.Lock()
        self._running = False
        self._last_claim: datetime | None = None
        self.runs = 0
        self.last_result: MaintenanceResult | None = None
        self.history: list[MaintenanceResult] = []
        # Cursor inicial derivado do relógio: reinícios não recomeçam sempre pela 1ª categoria.
        window = int(clock.now().timestamp() // max(interval_seconds, 1))
        self.cursor = window % len(CATEGORY_ORDER)

    def try_claim(self) -> bool:
        """True para UMA única chamada por intervalo (e nunca com outra execução em curso)."""
        if not self._lock.acquire(blocking=False):
            return False
        try:
            now = self._clock.now()
            if self._running or (self._last_claim is not None and now - self._last_claim < self._interval):
                return False
            self._running, self._last_claim = True, now
            return True
        finally:
            self._lock.release()

    def run_claimed(self) -> None:
        try:
            result = run_maintenance(self._engine, self._clock, self._policy, self._limits,
                                     categories=CATEGORY_ORDER, start=self.cursor,
                                     checkpoint=self._checkpoint, operation="opportunistic")
            self.cursor = result.next_start                    # progresso mantido para a próxima execução
            self.last_result = result
            self.history.append(result)
            del self.history[:-50]
            self.runs += 1
        except Exception as exc:  # noqa: BLE001 — manutenção nunca derruba a requisição
            logger.warning("maintenance operation=opportunistic failure=%s", type(exc).__name__)
        finally:
            with self._lock:
                self._running = False

    def maybe_run(self) -> None:
        if self.try_claim():
            self.run_claimed()
