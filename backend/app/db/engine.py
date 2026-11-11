"""Engine SQLAlchemy Core (síncrono, psycopg 3) criado SOB DEMANDA e sempre encerrado.

Cada conexão do pool nasce com:
- `lock_timeout` e `statement_timeout` da configuração;
- `search_path` fixado no esquema do projeto (o código ainda qualifica `prazoai.<tabela>`);
- `application_name` para identificar a origem no PostgreSQL;
- `connect_timeout` (segundos) para não travar se o servidor não responder.
`hide_parameters=True` evita que valores de parâmetros apareçam em mensagens de erro.
"""
from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager

from sqlalchemy import Engine, create_engine

from app.db.config import SCHEMA, DatabaseConfig


def connection_options(cfg: DatabaseConfig) -> str:
    return (
        f"-c lock_timeout={cfg.lock_timeout_ms} "
        f"-c statement_timeout={cfg.statement_timeout_ms} "
        f"-c search_path={SCHEMA}"
    )


def create_db_engine(cfg: DatabaseConfig, *, application_name: str = "prazoai-backend") -> Engine:
    return create_engine(
        cfg.url,
        pool_size=cfg.pool_size,
        max_overflow=cfg.max_overflow,
        pool_timeout=cfg.pool_timeout_seconds,
        pool_pre_ping=True,
        hide_parameters=True,
        connect_args={
            "connect_timeout": cfg.connect_timeout_seconds,
            "options": connection_options(cfg),
            "application_name": application_name,
        },
    )


@contextmanager
def engine_scope(cfg: DatabaseConfig, *, application_name: str = "prazoai-backend") -> Iterator[Engine]:
    """Cria o engine e garante `dispose()` (fecha todas as conexões do pool) ao sair."""
    engine = create_db_engine(cfg, application_name=application_name)
    try:
        yield engine
    finally:
        engine.dispose()
