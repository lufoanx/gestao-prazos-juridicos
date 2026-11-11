"""Metadados das tabelas do projeto (fonte única para Alembic e, a partir da P2, repositórios).

P1: NENHUMA tabela de negócio. Convenção de nomes explícita para constraints e índices, e todas as
tabelas no esquema `prazoai`.
"""
from __future__ import annotations

from sqlalchemy import MetaData

from app.db.config import SCHEMA

NAMING_CONVENTION = {
    "ix": "ix_%(table_name)s_%(column_0_N_name)s",
    "uq": "uq_%(table_name)s_%(column_0_N_name)s",
    "ck": "ck_%(table_name)s_%(constraint_name)s",
    "fk": "fk_%(table_name)s_%(column_0_N_name)s_%(referred_table_name)s",
    "pk": "pk_%(table_name)s",
}

metadata = MetaData(schema=SCHEMA, naming_convention=NAMING_CONVENTION)
