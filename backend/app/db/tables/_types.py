"""Tipos e colunas comuns das tabelas (P2).

- IDs: `uuid` nativo do PostgreSQL (a API continuará expondo o hex de 32 caracteres; conversão nos
  repositórios a partir da P3/P4);
- instantes: `timestamptz`, lidos SEMPRE como `datetime` com fuso UTC (`UtcInstant`): o driver devolve
  o valor no `TimeZone` da sessão, e a API não pode variar a representação conforme o servidor;
  datas civis: `date`; horário de agenda: `time` sem fuso;
- escopo pessoal/escritório: `scope_kind` + `owner_id`/`office_id` e a coluna gerada `scope_key`,
  usada nas FKs compostas que exigem o MESMO ambiente.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from sqlalchemy import Column, Computed, DateTime, ForeignKey, Text
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.engine import Dialect
from sqlalchemy.types import TypeDecorator

from app.db.config import SCHEMA

SCOPE_KEY_SQL = "scope_kind || ':' || COALESCE(owner_id::text, office_id::text)"
SCOPE_SHAPE_SQL = (
    "(scope_kind = 'personal' AND owner_id IS NOT NULL AND office_id IS NULL) "
    "OR (scope_kind = 'office' AND office_id IS NOT NULL AND owner_id IS NULL)"
)


def ref(table: str, column: str = "id") -> str:
    return f"{SCHEMA}.{table}.{column}"


def uuid_pk() -> Column:
    return Column("id", UUID(as_uuid=True), primary_key=True)


def uuid_fk(name: str, target: str, *, nullable: bool = False, ondelete: str | None = None, fk_name: str) -> Column:
    return Column(name, UUID(as_uuid=True), ForeignKey(ref(target), ondelete=ondelete, name=fk_name),
                  nullable=nullable)


class UtcInstant(TypeDecorator[datetime]):
    """`timestamptz` cujo valor lido é o MESMO instante, representado em UTC.

    O PostgreSQL entrega `timestamptz` no fuso da sessão (`TimeZone`); `astimezone(UTC)` só troca a
    representação (instante e microssegundos preservados). Um valor sem fuso não é "consertado" com
    `replace(tzinfo=...)`: seria adivinhar o instante, então é recusado. A escrita não muda.
    """

    impl = DateTime(timezone=True)
    cache_ok = True

    def process_result_value(self, value: Any, dialect: Dialect) -> datetime | None:
        if value is None:
            return None
        if value.tzinfo is None or value.utcoffset() is None:
            raise ValueError("timestamptz lido sem fuso: instante ambíguo")
        return value.astimezone(timezone.utc)


def instant(name: str, *, nullable: bool = False) -> Column:
    return Column(name, UtcInstant(), nullable=nullable)


def scope_columns(table: str) -> list[Column]:
    return [
        Column("scope_kind", Text, nullable=False),
        uuid_fk("owner_id", "users", nullable=True, fk_name=f"fk_{table}_owner_id_users"),
        uuid_fk("office_id", "offices", nullable=True, fk_name=f"fk_{table}_office_id_offices"),
        Column("scope_key", Text, Computed(SCOPE_KEY_SQL, persisted=True)),
    ]
