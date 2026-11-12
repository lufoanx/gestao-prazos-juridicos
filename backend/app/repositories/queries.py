"""Contrato de CONSULTAS do domínio (P4): filtros, autorização, busca, ordenação e paginação.

As duas implementações (memória e PostgreSQL) recebem os MESMOS critérios e devolvem a página, o
total e os contadores. No PostgreSQL, tudo é calculado no SQL, no mesmo snapshot da leitura
(REPEATABLE READ READ ONLY); contadores não dependem de haver linhas na página (página além da
última → `items=[]` com total correto). Ordenações sempre com desempate determinístico.

Autorização aplicada ANTES de filtrar e contar (mesmas regras de app/policies):
- prazo: pessoal → dono; escritório → vínculo atual + `deadline.read` + (visibilidade `all` OU responsável);
- intimação: pessoal → dono; escritório → vínculo atual + `deadline.read` + (`all` OU autor OU
  pendente com o usuário sugerido OU revisada cujo prazo vinculado tem o usuário como responsável);
- notificação: do destinatário, do escopo pedido, e cujo recurso ATUAL ainda é legível.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import date, time
from typing import TYPE_CHECKING, Protocol

from app.domain.deadlines import Comment, Deadline, HistoryEvent, Scope, ScopeKind
from app.domain.intimations import Intimation, IntimationEvent, Notification
from app.domain.org import Membership
from app.policies import deadlines as dl_policy
from app.policies import intimations as in_policy

if TYPE_CHECKING:
    from app.repositories.deadlines import UnitTransaction


@dataclass(frozen=True)
class Viewer:
    user_id: str
    membership: Membership | None

    @property
    def office_id(self) -> str | None:
        return self.membership.office_id if self.membership else None

    @property
    def can_read_office(self) -> bool:
        return self.membership is not None and self.membership.has("deadline.read")

    @property
    def sees_all(self) -> bool:
        return self.membership is not None and self.membership.visibility == "all"


@dataclass(frozen=True)
class DeadlineSearch:
    scope: Scope
    viewer: Viewer
    today: date
    soon_days: int
    q: str | None = None
    status: str | None = None
    urgency: str | None = None
    area: str | None = None
    responsible_id: str | None = None
    due_from: date | None = None
    due_to: date | None = None
    sort: str = "dueDate"
    direction: str = "asc"
    page: int = 1
    per_page: int = 20


@dataclass(frozen=True)
class MonthSearch:
    scope: Scope
    viewer: Viewer
    year: int
    month: int
    status: str | None
    page: int
    per_page: int


@dataclass(frozen=True)
class IntimationSearch:
    scope: Scope
    viewer: Viewer
    status: str | None
    q: str | None
    page: int
    per_page: int


@dataclass(frozen=True)
class NotificationSearch:
    viewer: Viewer
    kind: ScopeKind
    unread_only: bool
    page: int
    per_page: int


@dataclass(frozen=True)
class NotificationRow:
    notification: Notification
    deadline: Deadline | None          # recurso ATUAL (legível), para o resumo
    intimation: Intimation | None


class Queries(Protocol):
    def deadlines(self, c: DeadlineSearch) -> tuple[list[Deadline], int]: ...
    def month(self, c: MonthSearch) -> tuple[list[Deadline], int, dict[str, int]]: ...
    def comments(self, deadline_id: str, page: int, per_page: int) -> tuple[list[Comment], int]: ...
    def history(self, deadline_id: str, page: int, per_page: int) -> tuple[list[HistoryEvent], int]: ...
    def intimations(self, c: IntimationSearch) -> tuple[list[Intimation], int]: ...
    def events(self, intimation_id: str, page: int, per_page: int) -> tuple[list[IntimationEvent], int]: ...
    def notifications(self, c: NotificationSearch) -> tuple[list[NotificationRow], int, int]: ...
    def unread_ids(self, viewer: Viewer, kind: ScopeKind) -> list[str]: ...


# ---------------------------------------------------------------- regras puras (memória)
def urgency_level(d: Deadline, today: date, soon_days: int) -> str | None:
    if d.status != "open":
        return None
    days = (d.due_date - today).days
    return "overdue" if days < 0 else "today" if days == 0 else "soon" if days <= soon_days else "upcoming"


_STATUS_ORDER = {"open": 0, "completed": 1, "cancelled": 2}
_PRIORITY_ORDER = {"high": 0, "normal": 1}
SORT_KEYS = {
    "dueDate": lambda d: d.due_date,
    "title": lambda d: d.title.lower(),
    "priority": lambda d: _PRIORITY_ORDER[d.priority],
    "status": lambda d: _STATUS_ORDER[d.status],
    "createdAt": lambda d: d.created_at,
}


def _page(items: list, page: int, per_page: int) -> list:
    start = (page - 1) * per_page
    return items[start:start + per_page]


def matches_deadline(d: Deadline, c: DeadlineSearch) -> bool:
    if c.status and d.status != c.status:
        return False
    if c.urgency and urgency_level(d, c.today, c.soon_days) != c.urgency:
        return False
    if c.area and d.practice_area.lower() != c.area.lower():
        return False
    if c.responsible_id and d.responsible_id != c.responsible_id:
        return False
    if c.due_from and d.due_date < c.due_from:
        return False
    if c.due_to and d.due_date > c.due_to:
        return False
    if c.q:
        hay = f"{d.title} {d.case_number} {d.court} {d.practice_area}".lower()
        if c.q.lower() not in hay:
            return False
    return True


class MemoryQueries:
    """Implementação em memória sobre a unidade (mesmas regras de autorização das políticas)."""

    def __init__(self, tx: UnitTransaction) -> None:
        self._tx = tx

    def _linked_responsible(self, i: Intimation) -> str | None:
        d = self._tx.deadlines.get(i.deadline_id) if i.deadline_id else None
        return d.responsible_id if d else None

    def deadlines(self, c: DeadlineSearch) -> tuple[list[Deadline], int]:
        v = c.viewer
        items = [d for d in self._tx.deadlines.in_scope(c.scope)
                 if dl_policy.can_read(v.user_id, v.membership, d) and matches_deadline(d, c)]
        items.sort(key=lambda d: d.id)
        items.sort(key=SORT_KEYS[c.sort], reverse=c.direction == "desc")     # estável: desempate por id
        return _page(items, c.page, c.per_page), len(items)

    def month(self, c: MonthSearch) -> tuple[list[Deadline], int, dict[str, int]]:
        v = c.viewer
        items = [d for d in self._tx.deadlines.in_scope(c.scope)
                 if dl_policy.can_read(v.user_id, v.membership, d) and d.due_date.year == c.year
                 and d.due_date.month == c.month and (c.status is None or d.status == c.status)]
        items.sort(key=lambda d: (d.due_date, d.agenda_time or time(23, 59, 59), d.id))
        counts: dict[str, int] = {}
        for d in items:
            counts[d.due_date.isoformat()] = counts.get(d.due_date.isoformat(), 0) + 1
        return _page(items, c.page, c.per_page), len(items), counts

    def comments(self, deadline_id: str, page: int, per_page: int) -> tuple[list[Comment], int]:
        items = list(self._tx.deadlines.comments(deadline_id))
        return _page(items, page, per_page), len(items)

    def history(self, deadline_id: str, page: int, per_page: int) -> tuple[list[HistoryEvent], int]:
        items = list(self._tx.deadlines.history(deadline_id))
        return _page(items, page, per_page), len(items)

    def intimations(self, c: IntimationSearch) -> tuple[list[Intimation], int]:
        v = c.viewer
        items = [i for i in self._tx.intimations.in_scope(c.scope)
                 if in_policy.can_read(v.user_id, v.membership, i, self._linked_responsible(i))]
        items = [i for i in items if (i.status == c.status if c.status else i.status != "discarded")]
        if c.q:
            needle = c.q.lower()
            items = [i for i in items if needle in f"{i.file.name} {i.draft.title or ''} "
                     f"{i.draft.case_number or ''}".lower()]
        items.sort(key=lambda i: i.id)
        items.sort(key=lambda i: i.created_at, reverse=True)
        return _page(items, c.page, c.per_page), len(items)

    def events(self, intimation_id: str, page: int, per_page: int) -> tuple[list[IntimationEvent], int]:
        items = list(self._tx.intimations.events(intimation_id))
        return _page(items, page, per_page), len(items)

    def _visible_notifications(self, viewer: Viewer, kind: ScopeKind) -> list[NotificationRow]:
        out = []
        m = viewer.membership
        for n in self._tx.notifications.of_recipient(viewer.user_id):
            if kind == "personal":
                if not (n.scope.kind == "personal" and n.scope.owner_id == viewer.user_id):
                    continue
            elif not (n.scope.kind == "office" and m is not None and n.scope.office_id == m.office_id):
                continue
            if n.resource_type == "deadline":
                d = self._tx.deadlines.get(n.resource_id)
                if d is not None and dl_policy.can_read(viewer.user_id, m, d):
                    out.append(NotificationRow(n, d, None))
            else:
                i = self._tx.intimations.get(n.resource_id)
                if i is not None and in_policy.can_read(viewer.user_id, m, i, self._linked_responsible(i)):
                    out.append(NotificationRow(n, None, i))
        out.sort(key=lambda r: r.notification.id, reverse=True)
        out.sort(key=lambda r: r.notification.created_at, reverse=True)       # instante desc, id desc
        return out

    def notifications(self, c: NotificationSearch) -> tuple[list[NotificationRow], int, int]:
        rows = self._visible_notifications(c.viewer, c.kind)
        unread = sum(1 for r in rows if r.notification.read_at is None)
        if c.unread_only:
            rows = [r for r in rows if r.notification.read_at is None]
        return _page(rows, c.page, c.per_page), len(rows), unread

    def unread_ids(self, viewer: Viewer, kind: ScopeKind) -> list[str]:
        return [r.notification.id for r in self._visible_notifications(viewer, kind) if r.notification.read_at is None]
