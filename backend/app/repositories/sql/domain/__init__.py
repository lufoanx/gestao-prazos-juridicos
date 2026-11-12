"""Domínio no PostgreSQL (P4): escritórios, prazos, intimações e notificações.

`SqlUnitOfWork` implementa o contrato `app.repositories.unit.UnitOfWork` com uma ÚNICA conexão e
transação por operação. Detalhes em docs/backend/19-p4-dominio-postgresql.md.
"""
from app.repositories.sql.domain.unit import DomainLimits, SqlUnitOfWork

__all__ = ["DomainLimits", "SqlUnitOfWork"]
