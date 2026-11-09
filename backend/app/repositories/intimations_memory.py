"""Intimações e notificações EM MEMÓRIA (Etapa 5) — escritas preparadas (copy-on-write).

Índices mantidos dentro da transação e removidos junto com os registros:
- intimações: por escopo, por prazo vinculado (vínculo único e recíproco) e eventos;
- notificações: por destinatário e por chave de deduplicação (destinatário + evento).

Retenção (varredura no início da unidade, confirmada só no commit):
- intimações descartadas: removidas (com eventos e índices) após a retenção configurada;
- notificações lidas: removidas após a retenção configurada.
Capacidade:
- intimações por escopo e eventos por intimação: excesso → operação recusada (409);
- notificações por destinatário: POLÍTICA DA CAIXA — ao exceder o teto, removem-se primeiro
  as lidas mais antigas e depois as não lidas mais antigas (instante, id). Não bloqueia a
  operação principal e não se aplica a históricos.
"""
from __future__ import annotations

import threading
from dataclasses import dataclass
from datetime import datetime, timedelta

from app.domain.deadlines import Scope
from app.domain.intimations import Intimation, IntimationEvent, Notification
from app.repositories.deadlines_memory import CapacityError
from app.repositories.memory_tx import ConsistencyError, Fork, add_to_index, empty_state, remove_from_index


@dataclass(frozen=True)
class IntimationLimits:
    max_per_scope: int
    max_events_per_intimation: int
    discard_retention_seconds: int


@dataclass(frozen=True)
class NotificationLimits:
    max_per_recipient: int
    read_retention_seconds: int


@dataclass(frozen=True)
class IntimationState:
    intimations: dict[str, Intimation]
    by_scope: dict[str, frozenset[str]]
    by_deadline: dict[str, str]
    events: dict[str, tuple[IntimationEvent, ...]]


@dataclass(frozen=True)
class NotificationState:
    notifications: dict[str, Notification]
    by_recipient: dict[str, frozenset[str]]
    dedupe: dict[str, str]


class MemoryIntimationStore:
    def __init__(self, limits: IntimationLimits, purge_interval_seconds: int = 60) -> None:
        self.lock = threading.RLock()
        self.limits = limits
        self.purge_interval = timedelta(seconds=purge_interval_seconds)
        self.last_purge: datetime | None = None
        self.state: IntimationState = empty_state(IntimationState)

    @property
    def intimations(self) -> dict[str, Intimation]:
        return self.state.intimations

    @property
    def by_scope(self) -> dict[str, frozenset[str]]:
        return self.state.by_scope

    @property
    def by_deadline(self) -> dict[str, str]:
        return self.state.by_deadline

    @property
    def events(self) -> dict[str, tuple[IntimationEvent, ...]]:
        return self.state.events


class MemoryNotificationStore:
    def __init__(self, limits: NotificationLimits, purge_interval_seconds: int = 60) -> None:
        self.lock = threading.RLock()
        self.limits = limits
        self.purge_interval = timedelta(seconds=purge_interval_seconds)
        self.last_purge: datetime | None = None
        self.state: NotificationState = empty_state(NotificationState)

    @property
    def notifications(self) -> dict[str, Notification]:
        return self.state.notifications

    @property
    def by_recipient(self) -> dict[str, frozenset[str]]:
        return self.state.by_recipient

    @property
    def dedupe(self) -> dict[str, str]:
        return self.state.dedupe


class MemoryIntimationTransaction:
    def __init__(self, store: MemoryIntimationStore, now: datetime) -> None:
        self._store = store
        self._f: Fork[IntimationState] = Fork(store.state)
        self.now = now
        self.touched: set[str] = set()
        self.touched_scopes: set[str] = set()
        self.purged = False

    @property
    def changed(self) -> bool:
        return self._f.changed

    def build(self) -> IntimationState:
        return self._f.build()

    def maybe_purge(self) -> None:
        s = self._store
        if s.last_purge is None or self.now - s.last_purge >= s.purge_interval:
            self.purge()

    def purge(self) -> int:
        retention = timedelta(seconds=self._store.limits.discard_retention_seconds)
        removed = 0
        for i in list(self._f.r("intimations").values()):
            if i.status == "discarded" and i.closed_at is not None and self.now - i.closed_at >= retention:
                del self._f.w("intimations")[i.id]
                remove_from_index(self._f.w("by_scope"), i.scope.key, i.id)
                self._f.w("events").pop(i.id, None)
                removed += 1
        self.purged = True
        return removed

    def get(self, intimation_id: str) -> Intimation | None:
        return self._f.r("intimations").get(intimation_id)

    def by_deadline(self, deadline_id: str) -> Intimation | None:
        iid = self._f.r("by_deadline").get(deadline_id)
        return self.get(iid) if iid else None

    def in_scope(self, scope: Scope) -> list[Intimation]:
        items = self._f.r("intimations")
        return [items[i] for i in self._f.r("by_scope").get(scope.key, frozenset())]

    def put(self, intimation: Intimation) -> None:
        if intimation.deadline_id:
            owner = self._f.r("by_deadline").get(intimation.deadline_id)
            if owner is not None and owner != intimation.id:
                # Equivalente a UNIQUE(intimations.deadline_id): um prazo, uma intimação.
                raise ConsistencyError("prazo já vinculado a outra intimação")
        previous = self.get(intimation.id)
        if previous is not None and previous.scope != intimation.scope:
            remove_from_index(self._f.w("by_scope"), previous.scope.key, intimation.id)
        if previous is not None and previous.deadline_id and previous.deadline_id != intimation.deadline_id:
            self._f.w("by_deadline").pop(previous.deadline_id, None)
        self._f.w("intimations")[intimation.id] = intimation
        add_to_index(self._f.w("by_scope"), intimation.scope.key, intimation.id)
        if intimation.deadline_id:
            self._f.w("by_deadline")[intimation.deadline_id] = intimation.id
        self.touched.add(intimation.id)
        self.touched_scopes.add(intimation.scope.key)

    def events(self, intimation_id: str) -> tuple[IntimationEvent, ...]:
        return self._f.r("events").get(intimation_id, ())

    def add_event(self, event: IntimationEvent) -> None:
        self._f.w("events")[event.intimation_id] = self.events(event.intimation_id) + (event,)
        self.touched.add(event.intimation_id)

    def validate_capacity(self) -> None:
        lim = self._store.limits
        for key in self.touched_scopes:
            if len(self._f.r("by_scope").get(key, frozenset())) > lim.max_per_scope:
                raise CapacityError("intimation_limit_reached", "Limite de intimações do ambiente atingido.")
        for iid in self.touched:
            if len(self.events(iid)) > lim.max_events_per_intimation:
                raise CapacityError("intimation_history_limit_reached", "Limite de histórico da intimação atingido.")


class MemoryNotificationTransaction:
    def __init__(self, store: MemoryNotificationStore, now: datetime) -> None:
        self._store = store
        self._f: Fork[NotificationState] = Fork(store.state)
        self.now = now
        self.touched_recipients: set[str] = set()
        self.purged = False
        self.evicted: list[str] = []

    @property
    def changed(self) -> bool:
        return self._f.changed

    def build(self) -> NotificationState:
        return self._f.build()

    @staticmethod
    def dedupe_key(recipient_id: str, event_id: str) -> str:
        return f"{recipient_id}|{event_id}"

    def _delete(self, n: Notification) -> None:
        del self._f.w("notifications")[n.id]
        remove_from_index(self._f.w("by_recipient"), n.recipient_id, n.id)
        key = self.dedupe_key(n.recipient_id, n.event_id)
        if self._f.r("dedupe").get(key) == n.id:
            del self._f.w("dedupe")[key]

    def maybe_purge(self) -> None:
        s = self._store
        if s.last_purge is None or self.now - s.last_purge >= s.purge_interval:
            self.purge()

    def purge(self) -> int:
        retention = timedelta(seconds=self._store.limits.read_retention_seconds)
        old = [n for n in self._f.r("notifications").values() if n.read_at and self.now - n.read_at >= retention]
        for n in old:
            self._delete(n)
        self.purged = True
        return len(old)

    def get(self, notification_id: str) -> Notification | None:
        return self._f.r("notifications").get(notification_id)

    def of_recipient(self, recipient_id: str) -> list[Notification]:
        items = self._f.r("notifications")
        return [items[i] for i in self._f.r("by_recipient").get(recipient_id, frozenset())]

    def add(self, n: Notification) -> bool:
        """Adiciona se o par (destinatário, evento) ainda não existe. Retorna False se duplicada."""
        key = self.dedupe_key(n.recipient_id, n.event_id)
        if key in self._f.r("dedupe"):
            return False
        self._f.w("notifications")[n.id] = n
        add_to_index(self._f.w("by_recipient"), n.recipient_id, n.id)
        self._f.w("dedupe")[key] = n.id
        self.touched_recipients.add(n.recipient_id)
        return True

    def put(self, n: Notification) -> None:
        self._f.w("notifications")[n.id] = n

    def enforce_capacity(self) -> None:
        """Política da caixa: lidas mais antigas primeiro, depois não lidas mais antigas."""
        cap = self._store.limits.max_per_recipient
        for rid in self.touched_recipients:
            items = self.of_recipient(rid)
            excess = len(items) - cap
            if excess <= 0:
                continue
            ordered = sorted(items, key=lambda n: (n.read_at is None, n.created_at, n.id))
            for n in ordered[:excess]:
                self._delete(n)
                self.evicted.append(n.id)
