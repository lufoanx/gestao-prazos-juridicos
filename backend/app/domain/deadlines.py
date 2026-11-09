"""Prazos, comentários e eventos de histórico (Etapa 4, sem ORM).

Datas do prazo (`start_date`, `due_date`) são DATAS CIVIS (`datetime.date`), nunca
convertidas por fuso. Timestamps de eventos (`created_at`, `updated_at`, `at`) são
instantes com fuso (UTC), vindos do relógio injetável.

`due_date` é informado pelo usuário. `duration` e `counting_mode` são referências
organizacionais: o servidor não recalcula nem sobrescreve o vencimento e não exige
coerência entre eles. `reviewed` é uma declaração do usuário (conferi os dados), não
certificação jurídica nem validação automática.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, datetime, time
from typing import Any, Literal

Status = Literal["open", "completed", "cancelled"]
Priority = Literal["normal", "high"]
CountingMode = Literal["business", "calendar"]
ScopeKind = Literal["personal", "office"]

# Transições aprovadas. completed ↔ cancelled direto é proibido (reabrir antes).
TRANSITIONS: dict[str, frozenset[str]] = {
    "open": frozenset({"completed", "cancelled"}),
    "completed": frozenset({"open"}),
    "cancelled": frozenset({"open"}),
}


@dataclass(frozen=True)
class Scope:
    kind: ScopeKind
    owner_id: str | None = None   # pessoal
    office_id: str | None = None  # escritório

    @staticmethod
    def personal(owner_id: str) -> Scope:
        return Scope("personal", owner_id=owner_id)

    @staticmethod
    def office(office_id: str) -> Scope:
        return Scope("office", office_id=office_id)

    @property
    def key(self) -> str:
        return f"p:{self.owner_id}" if self.kind == "personal" else f"o:{self.office_id}"


@dataclass(frozen=True)
class Deadline:
    id: str
    scope: Scope
    title: str
    case_number: str
    court: str
    practice_area: str
    responsible_id: str
    status: Status
    priority: Priority
    start_date: date
    due_date: date
    counting_mode: CountingMode
    duration: int
    reviewed: bool
    agenda_time: time | None
    created_by: str
    created_at: datetime
    updated_at: datetime
    version: int = 1


@dataclass(frozen=True)
class Comment:
    id: str
    deadline_id: str
    author_id: str
    text: str
    created_at: datetime


@dataclass(frozen=True)
class HistoryEvent:
    id: str
    deadline_id: str
    actor_id: str
    action: str  # created | updated | reassigned | status_changed | transferred
    at: datetime
    details: dict[str, Any] = field(default_factory=dict)
