"""Repositórios de AUTENTICAÇÃO no PostgreSQL (P3), com SQLAlchemy Core e psycopg síncrono.

Importado SOMENTE quando STORAGE=postgres (o modo memory não carrega SQLAlchemy).
Protocolos detalhados em docs/backend/15-projeto-persistencia-postgresql.md, §4.3, e
docs/backend/18-p3-autenticacao-postgresql.md.
"""
from app.repositories.sql._base import SqlContext
from app.repositories.sql.resets import SqlPasswordResetRepository
from app.repositories.sql.schema_check import REQUIRED_REVISION, SchemaNotReadyError, ensure_schema_revision
from app.repositories.sql.sessions import SqlSessionRepository
from app.repositories.sql.users import SqlUserRepository

__all__ = [
    "SqlContext", "SqlUserRepository", "SqlSessionRepository", "SqlPasswordResetRepository",
    "REQUIRED_REVISION", "SchemaNotReadyError", "ensure_schema_revision",
]
