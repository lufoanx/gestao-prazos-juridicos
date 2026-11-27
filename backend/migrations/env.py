"""Ambiente do Alembic do PrazoAI.

- A URL vem de DATABASE_URL (Settings), validada sem expor credenciais; nunca de alembic.ini.
- Os testes podem injetar uma conexão pronta em `config.attributes["connection"]`.
- Tudo fica no esquema EXPLÍCITO `prazoai`, inclusive a tabela de versões; o esquema é criado
  (se faltar) na MESMA transação das migrations.
- Em homologação/produção (staging/production): exige TLS na conexão (sslmode) e a confirmação EXPLÍCITA
  do destino em PRAZOAI_CONFIRM_MIGRATION_TARGET ("host:porta/banco", sem credenciais) — proteção contra
  migrar o banco errado. Modo offline (--sql) não é suportado.
"""
from __future__ import annotations

import os
from logging.config import fileConfig

from alembic import context
from sqlalchemy import Connection, text

from app.core.config import HOSTED_DB_SSLMODES, Settings
from app.db.config import SCHEMA, database_config_from
from app.db.engine import create_db_engine
from app.db.tables import metadata  # registra as 14 tabelas (comparação com o esquema migrado)

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
    cfg = database_config_from(settings)
    if settings.is_hosted:
        if cfg.url.query.get("sslmode") not in HOSTED_DB_SSLMODES:
            raise SystemExit(
                f"Migrations em ENVIRONMENT={settings.environment} exigem sslmode=require|verify-ca|verify-full."
            )
        if os.environ.get("PRAZOAI_CONFIRM_MIGRATION_TARGET") != cfg.describe():
            raise SystemExit(
                f"Migrations em ENVIRONMENT={settings.environment}: confirme o destino com "
                f"PRAZOAI_CONFIRM_MIGRATION_TARGET={cfg.describe()}"
            )
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
