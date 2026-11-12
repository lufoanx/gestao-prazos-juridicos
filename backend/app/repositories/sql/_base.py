"""Infraestrutura comum dos repositórios SQL: transação, relógio pós-lock, pontos de controle,
conversão de identificadores e tradução SEGURA de erros.

Regras:
- cada operação atômica = UMA transação numa ÚNICA conexão (`SqlContext.transaction`); qualquer
  exceção → ROLLBACK, e a conexão volta ao pool;
- o instante da operação vem do relógio injetável e é capturado DEPOIS dos bloqueios
  (`SqlContext.now()` chamado após os `SELECT … FOR …`); `now()`/CURRENT_TIMESTAMP do banco não
  são usados;
- `checkpoint(nome)` é um gancho sem efeito em produção, usado pelos testes de concorrência e de
  falha injetada (pausar depois de obter os bloqueios; falhar antes do COMMIT);
- só violações CONHECIDAS (pelo nome da constraint) viram erros de domínio; o resto propaga;
- D6: SQLSTATE 40P01 (deadlock) e 55P03 (bloqueio indisponível / lock_timeout) viram
  `ConcurrentUpdateError` (409 `concurrent_update`) DEPOIS do ROLLBACK e da devolução da conexão;
  não há repetição automática. Qualquer outro erro do banco continua inesperado.
"""
from __future__ import annotations

import uuid
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import datetime

from sqlalchemy import Connection, Engine
from sqlalchemy.exc import DBAPIError, IntegrityError

from app.core.clock import Clock
from app.core.errors import ConcurrentUpdateError

#: SQLSTATEs tratados como conflito de concorrência (D6). Nada além disso.
CONCURRENCY_SQLSTATES = frozenset({"40P01", "55P03"})


def _no_checkpoint(_name: str) -> None:
    return None


@dataclass
class SqlContext:
    engine: Engine
    clock: Clock
    checkpoint: Callable[[str], None] = field(default=_no_checkpoint)

    @contextmanager
    def transaction(self) -> Iterator[Connection]:
        """BEGIN … COMMIT numa única conexão; ROLLBACK em qualquer exceção."""
        try:
            with self.engine.begin() as conn:     # ao sair com erro: ROLLBACK e conexão devolvida
                yield conn
        except DBAPIError as exc:
            if sqlstate(exc) in CONCURRENCY_SQLSTATES:
                raise ConcurrentUpdateError() from None
            raise

    @contextmanager
    def read(self) -> Iterator[Connection]:
        try:
            with self.engine.connect() as conn:
                yield conn
        except DBAPIError as exc:
            if sqlstate(exc) in CONCURRENCY_SQLSTATES:
                raise ConcurrentUpdateError() from None
            raise

    def now(self) -> datetime:
        """Instante da operação: chamar SOMENTE depois de obter os bloqueios necessários."""
        return self.clock.now()


def to_uuid(value: str) -> uuid.UUID | None:
    """ID da API (hex de 32) → uuid; formato inválido → None (tratado como inexistente)."""
    try:
        return uuid.UUID(hex=value)
    except (ValueError, TypeError, AttributeError):
        return None


def to_hex(value: uuid.UUID) -> str:
    return value.hex


def sqlstate(exc: DBAPIError) -> str | None:
    return getattr(getattr(exc, "orig", None), "sqlstate", None)


def violated_constraint(exc: IntegrityError) -> str | None:
    """Nome da constraint violada (psycopg `diag`), sem expor a mensagem nem os valores."""
    diag = getattr(getattr(exc, "orig", None), "diag", None)
    return getattr(diag, "constraint_name", None)
