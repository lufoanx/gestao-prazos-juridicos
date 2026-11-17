"""Conexão EXCLUSIVA do worker de recuperação no PostgreSQL e cancelamento com propriedade confirmada
(doc 21, §4.8).

- Engine próprio com `NullPool`: cada etapa de banco abre UMA conexão física e a FECHA ao fim; nada é
  devolvido a pool compartilhado. O pool da API nunca é usado pelo worker.
- Cada transação do worker aplica `SET LOCAL lock_timeout/statement_timeout` próprios
  (`RECOVERY_DB_LOCK_TIMEOUT_MS` / `RECOVERY_DB_STATEMENT_TIMEOUT_MS`).
- Registro de cancelamento (app/recovery/cancel.py): um `Lock` + geração. O worker publica
  `{geração, conexão, ATIVA}` antes do primeiro comando; o encerramento só chama
  `cancel_safe(timeout)` com o registro ATIVO e AINDA segurando o lock. O worker marca LIBERANDO e
  remove o registro sob o mesmo lock ANTES de fechar a conexão — portanto nenhum cancelamento alcança
  uma conexão em liberação ou já fechada.
- Capacidade (verificada, não presumida): `cancel_safe` só respeita timeout com libpq ≥ 17. Sem a
  capacidade, NENHUM cancelamento ativo é feito (nem `cancel()` nem `cancel_safe`).
"""
from __future__ import annotations

from collections.abc import Callable, Iterator
from contextlib import contextmanager

from sqlalchemy import Connection, Engine, create_engine
from sqlalchemy.exc import DBAPIError
from sqlalchemy.pool import NullPool

from app.core.clock import Clock
from app.core.errors import ConcurrentUpdateError
from app.recovery.cancel import CancelRegistry
from app.repositories.sql._base import CONCURRENCY_SQLSTATES, SqlContext, _no_checkpoint, sqlstate

WORKER_APPLICATION_NAME = "prazoai-recovery"


class ExclusiveSqlContext(SqlContext):
    """`SqlContext` do worker: conexão exclusiva por etapa, limites próprios e registro de cancelamento.

    `read()` também abre transação (para o `SET LOCAL`); os repositórios SQL existentes são
    reutilizados sem alteração.
    """

    def __init__(self, engine: Engine, clock: Clock, registry: CancelRegistry, *, lock_timeout_ms: int,
                 statement_timeout_ms: int, checkpoint: Callable[[str], None] = _no_checkpoint) -> None:
        super().__init__(engine=engine, clock=clock, checkpoint=checkpoint)
        self.registry = registry
        self._lock_ms = int(lock_timeout_ms)
        self._stmt_ms = int(statement_timeout_ms)

    @contextmanager
    def _exclusive(self) -> Iterator[Connection]:
        conn = self.engine.connect()                     # NullPool: conexão física nova
        self.registry.opened()
        try:
            generation = self.registry.publish(conn.connection.driver_connection)
            try:
                with conn.begin():                       # erro → ROLLBACK
                    conn.exec_driver_sql(f"SET LOCAL lock_timeout = {self._lock_ms}")
                    conn.exec_driver_sql(f"SET LOCAL statement_timeout = {self._stmt_ms}")
                    self.checkpoint("recovery:db_active")
                    yield conn
            finally:
                self.registry.withdraw(generation)       # antes de fechar
        finally:
            try:
                conn.close()                             # NullPool: fecha a conexão física
            finally:
                self.registry.closed()

    @contextmanager
    def transaction(self) -> Iterator[Connection]:
        try:
            with self._exclusive() as conn:
                yield conn
        except DBAPIError as exc:
            if sqlstate(exc) in CONCURRENCY_SQLSTATES:
                raise ConcurrentUpdateError() from None
            raise

    @contextmanager
    def read(self) -> Iterator[Connection]:
        with self.transaction() as conn:
            yield conn


def create_worker_engine(cfg) -> Engine:
    """Engine exclusivo do worker: mesmo destino da configuração, `NullPool`, nome de aplicação próprio."""
    from app.db.engine import connect_arguments

    return create_engine(cfg.url, poolclass=NullPool, hide_parameters=True,
                         connect_args=connect_arguments(cfg, application_name=WORKER_APPLICATION_NAME))
