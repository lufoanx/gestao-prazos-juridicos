"""Interfaces do repositório de prazos (contrato para a futura persistência).

Operações de prazo rodam SEMPRE dentro da unidade de trabalho (`UnitTransaction`), que
também dá acesso aos vínculos de escritório: autorização, responsável ativo e escrita
são decididos na mesma transação.

PostgreSQL (planejado): uma transação de banco por unidade; `SELECT ... FOR UPDATE` no
prazo e nos vínculos envolvidos; coluna `version` para o controle otimista
(`UPDATE ... WHERE id = :id AND version = :v`); histórico e comentário na mesma transação.
"""
from __future__ import annotations

from datetime import datetime
from typing import Protocol

from app.domain.deadlines import Comment, Deadline, HistoryEvent, Scope
from app.repositories.org import OrgTransaction


class DeadlineTransaction(Protocol):
    @property
    def now(self) -> datetime: ...

    def get(self, deadline_id: str) -> Deadline | None: ...
    def in_scope(self, scope: Scope) -> list[Deadline]: ...
    def count_in_scope(self, scope: Scope) -> int: ...
    def open_in_office_for(self, office_id: str, user_id: str) -> list[Deadline]: ...
    def put(self, deadline: Deadline) -> None: ...
    def comments(self, deadline_id: str) -> tuple[Comment, ...]: ...
    def add_comment(self, comment: Comment) -> None: ...
    def history(self, deadline_id: str) -> tuple[HistoryEvent, ...]: ...
    def add_history(self, event: HistoryEvent) -> None: ...


class UnitTransaction(Protocol):
    """Transação composta: escritórios + prazos, com um único instante `now`."""

    @property
    def now(self) -> datetime: ...

    @property
    def org(self) -> OrgTransaction: ...

    @property
    def deadlines(self) -> DeadlineTransaction: ...

    def checkpoint(self, name: str) -> None:
        """Ponto nomeado da operação (usado para injeção de falhas nos testes)."""
        ...
