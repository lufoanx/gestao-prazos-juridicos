"""Verificação explícita de conectividade: `python -m app.db check`.

Lê DATABASE_URL, conecta, mostra o destino (sem credenciais), a versão do servidor, os timeouts
efetivos e a revisão do Alembic, e encerra o engine. Não cria nem altera nada. A aplicação web não
executa isto nem se conecta ao banco nesta entrega.
"""
from __future__ import annotations

import sys

from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError

from app.core.config import Settings
from app.db.config import SCHEMA, DatabaseConfigError, database_config_from
from app.db.engine import engine_scope


def check(settings: Settings) -> int:
    if settings.is_production:
        print("Persistência ainda não liberada em ENVIRONMENT=production (P1).", file=sys.stderr)
        return 2
    try:
        cfg = database_config_from(settings)
    except DatabaseConfigError as exc:
        print(f"Configuração inválida: {exc}", file=sys.stderr)
        return 2
    try:
        with engine_scope(cfg, application_name="prazoai-check") as engine, engine.connect() as conn:
            version = conn.execute(text("SHOW server_version")).scalar_one()
            lock = conn.execute(text("SHOW lock_timeout")).scalar_one()
            stmt = conn.execute(text("SHOW statement_timeout")).scalar_one()
            has_versions = conn.execute(
                text("SELECT to_regclass(:t) IS NOT NULL"), {"t": f"{SCHEMA}.alembic_version"}
            ).scalar_one()
            revision = (
                conn.execute(text(f'SELECT version_num FROM "{SCHEMA}".alembic_version')).scalar_one_or_none()
                if has_versions else None
            )
    except SQLAlchemyError as exc:
        # Só a classe do erro: mensagens do driver podem conter o nome do usuário.
        cause = getattr(exc, "orig", None) or exc
        print(f"Falha ao conectar em {cfg.describe()}: {type(cause).__name__}", file=sys.stderr)
        return 1
    print(f"destino: {cfg.describe()}")
    print(f"servidor: PostgreSQL {version}")
    print(f"lock_timeout: {lock} | statement_timeout: {stmt}")
    print(f"revisão do esquema: {revision or 'nenhuma (rode: alembic upgrade head)'}")
    return 0


def main(argv: list[str]) -> int:
    if argv[1:] != ["check"]:
        print("uso: python -m app.db check", file=sys.stderr)
        return 2
    try:
        settings = Settings()
    except ValueError as exc:
        print(f"Configuração inválida: {exc}", file=sys.stderr)
        return 2
    return check(settings)


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
