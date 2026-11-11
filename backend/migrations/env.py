"""Ambiente do Alembic do PrazoAI.

- A URL vem de DATABASE_URL (Settings), validada sem expor credenciais; nunca de alembic.ini.
- Os testes podem injetar uma conexão pronta em `config.attributes["connection"]`.
- Tudo fica no esquema EXPLÍCITO `prazoai`, inclusive a tabela de versões; o esquema é criado
  (se faltar) na MESMA transação das migrations.
- Bloqueado em ENVIRONMENT=production nesta fase (P1). Modo offline (--sql) não é suportado.
"""
from __future__ import annotations

from logging.config import fileConfig

from alembic import context
from sqlalchemy import Connection, text

from app.core.config import Settings
from app.db.config import SCHEMA, database_config_from
from app.db.engine import create_db_engine
from app.db.metadata import metadata

config = context.config


def _run(connection: Connection) -> None:
    context.configure(
        connection=connection,
        target_metadata=metadata,
        version_table_schema=SCHEMA,
        include_schemas=False,
    )
    with context.begin_transaction():
        connection.execute(text(f'CREATE SCHEMA IF NOT EXISTS "{SCHEMA}"'))
        context.run_migrations()


def run_online() -> None:
    injected = config.attributes.get("connection")
    if injected is not None:
        _run(injected)
        return
    if config.config_file_name:          # só na linha de comando (não reconfigura o log dos testes)
        fileConfig(config.config_file_name, disable_existing_loggers=False)
    settings = Settings()
    if settings.is_production:
        raise SystemExit("Migrations bloqueadas em ENVIRONMENT=production nesta fase (P1).")
    cfg = database_config_from(settings)
    engine = create_db_engine(cfg, application_name="prazoai-migrations")
    try:
        with engine.connect() as connection:
            _run(connection)
            connection.commit()
    finally:
        engine.dispose()


if context.is_offline_mode():
    raise SystemExit("Modo offline (--sql) não é suportado nesta fase.")
run_online()
