"""Verificação SOMENTE LEITURA da revisão do esquema antes de habilitar o modo SQL.

Não cria, altera nem migra nada: se a tabela de versões não existir ou a revisão for diferente da
exigida, a aplicação recusa iniciar. Migrations rodam apenas por comando explícito.
"""
from __future__ import annotations

from sqlalchemy import Engine, text

from app.db.config import SCHEMA

#: Revisão Alembic exigida (P4: 0003 — ordem interna `seq` de históricos, eventos e comentários).
REQUIRED_REVISION = "0003"


class SchemaNotReadyError(RuntimeError):
    """Esquema ausente ou incompatível com a versão do código."""


def ensure_schema_revision(engine: Engine, required: str = REQUIRED_REVISION) -> None:
    with engine.connect() as conn:
        conn.exec_driver_sql("SET TRANSACTION READ ONLY")
        exists = conn.execute(text("SELECT to_regclass(:t) IS NOT NULL"),
                              {"t": f"{SCHEMA}.alembic_version"}).scalar_one()
        revision = None
        if exists:
            revision = conn.execute(text(f'SELECT version_num FROM "{SCHEMA}".alembic_version')).scalar_one_or_none()
        conn.rollback()
    if revision != required:
        found = revision or "nenhuma"
        raise SchemaNotReadyError(
            f"Esquema do banco na revisão {found}; esta versão exige {required}. "
            "Rode 'alembic upgrade head' explicitamente (migrations nunca rodam no startup)."
        )
