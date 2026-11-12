"""Contrato da unidade de trabalho do DOMÍNIO (escritórios, prazos, intimações, notificações).

Implementações: `MemoryUnitOfWork` (repositories/unit_of_work.py) e `SqlUnitOfWork`
(repositories/sql/domain/unit.py). Os serviços dependem SÓ deste contrato.

- `unit(clock)`: transação de ESCRITA entre os quatro módulos; rollback integral em qualquer exceção.
  `tx.now` é o instante obtido DEPOIS dos bloqueios necessários.
- `transaction(clock)`: escrita só de escritórios (sem remover vínculos).
- `read(clock)`: LEITURA consistente (no PostgreSQL: REPEATABLE READ READ ONLY, um snapshot).
- `purge(now)`: retenção explícita (no PostgreSQL, expurgo global em lotes fica para a P5).
"""
from __future__ import annotations

from collections.abc import Callable
from contextlib import AbstractContextManager
from datetime import datetime
from typing import Protocol

from app.core.clock import Clock
from app.repositories.deadlines import UnitTransaction
from app.repositories.org import OrgTransaction


class UnitOfWork(Protocol):
    fault: Callable[[str], None] | None

    def unit(self, clock: Clock) -> AbstractContextManager[UnitTransaction]: ...

    def transaction(self, clock: Clock) -> AbstractContextManager[OrgTransaction]: ...

    def read(self, clock: Clock) -> AbstractContextManager[UnitTransaction]: ...

    def purge(self, now: datetime) -> int: ...
