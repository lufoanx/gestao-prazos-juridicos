"""Repositório de prazos EM MEMÓRIA (Etapa 4) — escritas preparadas (copy-on-write).

Limites de crescimento (validados na PREPARAÇÃO FINAL, antes de confirmar qualquer
parte da operação; nada é truncado ou apagado silenciosamente):
- prazos por escopo (pessoal de um usuário / escritório);
- comentários por prazo;
- eventos de histórico por prazo.
"""
from __future__ import annotations

import threading
from dataclasses import dataclass
from datetime import datetime

from app.domain.deadlines import Comment, Deadline, HistoryEvent, Scope
from app.repositories.memory_tx import Fork, add_to_index, empty_state, remove_from_index


@dataclass(frozen=True)
class DeadlineLimits:
    max_per_scope: int
    max_comments_per_deadline: int
    max_history_per_deadline: int


class CapacityError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass(frozen=True)
class DeadlineState:
    deadlines: dict[str, Deadline]
    by_scope: dict[str, frozenset[str]]
    comments: dict[str, tuple[Comment, ...]]
    history: dict[str, tuple[HistoryEvent, ...]]


class MemoryDeadlineStore:
    def __init__(self, limits: DeadlineLimits) -> None:
        self.lock = threading.RLock()
        self.limits = limits
        self.state: DeadlineState = empty_state(DeadlineState)

    @property
    def deadlines(self) -> dict[str, Deadline]:
        return self.state.deadlines

    @property
    def by_scope(self) -> dict[str, frozenset[str]]:
        return self.state.by_scope

    @property
    def comments(self) -> dict[str, tuple[Comment, ...]]:
        return self.state.comments

    @property
    def history(self) -> dict[str, tuple[HistoryEvent, ...]]:
        return self.state.history


class MemoryDeadlineTransaction:
    def __init__(self, store: MemoryDeadlineStore, now: datetime) -> None:
        self._store = store
        self._f: Fork[DeadlineState] = Fork(store.state)
        self.now = now
        self.touched: set[str] = set()
        self.touched_scopes: set[str] = set()

    @property
    def changed(self) -> bool:
        return self._f.changed

    def build(self) -> DeadlineState:
        return self._f.build()

    def get(self, deadline_id: str) -> Deadline | None:
        return self._f.r("deadlines").get(deadline_id)

    def in_scope(self, scope: Scope) -> list[Deadline]:
        ds = self._f.r("deadlines")
        return [ds[i] for i in self._f.r("by_scope").get(scope.key, frozenset())]

    def count_in_scope(self, scope: Scope) -> int:
        return len(self._f.r("by_scope").get(scope.key, frozenset()))

    def open_in_office_for(self, office_id: str, user_id: str) -> list[Deadline]:
        return [
            d for d in self.in_scope(Scope.office(office_id))
            if d.status == "open" and d.responsible_id == user_id
        ]

    def put(self, deadline: Deadline) -> None:
        previous = self.get(deadline.id)
        if previous is not None and previous.scope != deadline.scope:
            remove_from_index(self._f.w("by_scope"), previous.scope.key, deadline.id)
        self._f.w("deadlines")[deadline.id] = deadline
        add_to_index(self._f.w("by_scope"), deadline.scope.key, deadline.id)
        self.touched.add(deadline.id)
        self.touched_scopes.add(deadline.scope.key)

    def comments(self, deadline_id: str) -> tuple[Comment, ...]:
        return self._f.r("comments").get(deadline_id, ())

    def add_comment(self, comment: Comment) -> None:
        self._f.w("comments")[comment.deadline_id] = self.comments(comment.deadline_id) + (comment,)
        self.touched.add(comment.deadline_id)

    def history(self, deadline_id: str) -> tuple[HistoryEvent, ...]:
        return self._f.r("history").get(deadline_id, ())

    def add_history(self, event: HistoryEvent) -> None:
        self._f.w("history")[event.deadline_id] = self.history(event.deadline_id) + (event,)
        self.touched.add(event.deadline_id)

    def validate_capacity(self) -> None:
        """Preparação final: verifica TODOS os limites antes de qualquer publicação."""
        lim = self._store.limits
        for key in self.touched_scopes:
            if len(self._f.r("by_scope").get(key, frozenset())) > lim.max_per_scope:
                raise CapacityError("deadline_limit_reached", "Limite de prazos do ambiente atingido.")
        for did in self.touched:
            if len(self.comments(did)) > lim.max_comments_per_deadline:
                raise CapacityError("comment_limit_reached", "Limite de comentários do prazo atingido.")
            if len(self.history(did)) > lim.max_history_per_deadline:
                raise CapacityError("history_limit_reached", "Limite de histórico do prazo atingido.")
