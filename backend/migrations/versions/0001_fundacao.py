"""Fundação (P1): revisão inicial VAZIA e reversível.

Não cria tabelas de negócio. Serve para marcar o ponto de partida do esquema `prazoai` e validar o
ciclo upgrade → downgrade → upgrade no CI. As tabelas aprovadas no projeto (doc 15) chegam na P2.

Revisão: 0001
Anterior: nenhuma
"""
from __future__ import annotations

from collections.abc import Sequence

revision: str = "0001"
down_revision: str | Sequence[str] | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
