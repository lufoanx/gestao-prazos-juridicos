"""P4: ordem INTERNA de inserção em históricos, eventos e comentários (`seq`).

Acrescenta `seq bigint GENERATED ALWAYS AS IDENTITY (CACHE 1, NO CYCLE)` a `deadline_history`,
`intimation_events` e `deadline_comments`, com unicidade explícita em (recurso, seq).

Motivo: eventos de uma mesma operação compartilham o mesmo instante (`tx.now`) e os IDs são UUIDs
aleatórios; sem `seq`, a ordem entre eles seria arbitrária. `seq` NÃO é horário, NÃO é contador sem
lacunas (rollbacks consomem valores) e NÃO é ordem global de commits; serve só para ordenar, de forma
determinística, os registros de UM recurso, cujos escritores são serializados pela unidade de trabalho.

Dados existentes: preenchidos de forma determinística por (instante, id) — a ordem ORIGINAL de
inserção de registros antigos com instante idêntico não pode ser recuperada. A identidade continua
depois do maior valor preenchido (sem colisão).

Downgrade: remove só a unicidade, a identidade (com sua sequência) e a coluna; os registros ficam
(a informação de ordenação interna é perdida).

Revisão: 0003
Anterior: 0002
"""
from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "0003"
down_revision: str | Sequence[str] | None = "0002"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

S = "prazoai"
#: tabela → (coluna do recurso, coluna do instante)
TABLES = (
    ("deadline_history", "deadline_id", "at"),
    ("intimation_events", "intimation_id", "at"),
    ("deadline_comments", "deadline_id", "created_at"),
)


def upgrade() -> None:
    for table, resource, instant in TABLES:
        op.execute(f"ALTER TABLE {S}.{table} ADD COLUMN seq bigint")
        op.execute(
            f"UPDATE {S}.{table} AS t SET seq = r.rn FROM ("
            f"SELECT id, row_number() OVER (ORDER BY {instant}, id) AS rn FROM {S}.{table}) AS r "
            f"WHERE t.id = r.id"
        )
        op.execute(f"ALTER TABLE {S}.{table} ALTER COLUMN seq SET NOT NULL")
        op.execute(
            f"ALTER TABLE {S}.{table} ALTER COLUMN seq ADD GENERATED ALWAYS AS IDENTITY "
            f"(SEQUENCE NAME {S}.{table}_seq_seq CACHE 1 NO CYCLE)"
        )
        # continua DEPOIS do maior valor preenchido (tabela vazia: começa em 1)
        op.execute(
            f"SELECT setval('{S}.{table}_seq_seq', COALESCE((SELECT max(seq) FROM {S}.{table}), 0) + 1, false)"
        )
        op.execute(f"ALTER TABLE {S}.{table} ADD CONSTRAINT uq_{table}_{resource}_seq UNIQUE ({resource}, seq)")


def downgrade() -> None:
    for table, resource, _instant in reversed(TABLES):
        op.execute(f"ALTER TABLE {S}.{table} DROP CONSTRAINT uq_{table}_{resource}_seq")
        op.execute(f"ALTER TABLE {S}.{table} ALTER COLUMN seq DROP IDENTITY")      # remove a sequência
        op.execute(f"ALTER TABLE {S}.{table} DROP COLUMN seq")
