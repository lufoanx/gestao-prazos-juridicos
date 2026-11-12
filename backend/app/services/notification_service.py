"""Notificações internas (Etapa 5): leitura individual com autorização ATUAL.

- Cada notificação tem um destinatário; não guarda título, processo nem conteúdo.
- Listagem, contagem, marcação como lida e "ler todas" consideram SOMENTE notificações do
  próprio destinatário cujo recurso ele ainda pode ler agora; as demais ficam ocultas
  (não são apagadas; somem pela retenção/política da caixa).
- O resumo (título, processo, vencimento / nome do arquivo) é projetado no momento da
  leitura, a partir do recurso autorizado.
- Ambiente pessoal: endpoints aceitam `scope=personal`, mas esta etapa não gera
  notificações pessoais. Não é um sistema de alertas de vencimento (sem lembretes agendados).
"""
from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass, replace
from typing import Any

from app.core.clock import Clock
from app.domain.deadlines import ScopeKind
from app.domain.intimations import Notification
from app.domain.org import Membership
from app.policies import deadlines as dl_policy
from app.policies import intimations as in_policy
from app.policies.org import NOT_FOUND
from app.repositories.deadlines import UnitTransaction
from app.repositories.queries import NotificationRow, NotificationSearch, Viewer
from app.repositories.unit import UnitOfWork
from app.services import deadline_ops as ops


@dataclass(frozen=True)
class NotificationItem:
    notification: Notification
    summary: dict[str, Any]


class NotificationService:
    def __init__(self, *, unit_of_work: UnitOfWork, clock: Clock) -> None:
        self._uow = unit_of_work
        self._clock = clock

    @contextmanager
    def _unit(self) -> Iterator[UnitTransaction]:
        with self._uow.unit(self._clock) as tx:
            yield tx

    @contextmanager
    def _read(self) -> Iterator[UnitTransaction]:
        with self._uow.read(self._clock) as tx:
            yield tx

    @staticmethod
    def _summary_of(row: NotificationRow) -> dict[str, Any]:
        if row.deadline is not None:
            d = row.deadline
            return {"title": d.title, "caseNumber": d.case_number, "dueDate": d.due_date.isoformat()}
        assert row.intimation is not None
        i = row.intimation
        return {"fileName": i.file.name, "title": i.draft.title, "status": i.status}

    @staticmethod
    def _summary(tx: UnitTransaction, user_id: str, m: Membership | None, n: Notification) -> dict[str, Any] | None:
        """Resumo do recurso SE o destinatário ainda pode lê-lo; senão None (oculta)."""
        if n.resource_type == "deadline":
            d = tx.deadlines.get(n.resource_id)
            if d is None or not dl_policy.can_read(user_id, m, d):
                return None
            return {"title": d.title, "caseNumber": d.case_number, "dueDate": d.due_date.isoformat()}
        i = tx.intimations.get(n.resource_id)
        if i is None:
            return None
        linked = tx.deadlines.get(i.deadline_id) if i.deadline_id else None
        if not in_policy.can_read(user_id, m, i, linked.responsible_id if linked else None):
            return None
        return {"fileName": i.file.name, "title": i.draft.title, "status": i.status}

    def list_notifications(
        self, user_id: str, kind: ScopeKind, unread_only: bool, page: int, per_page: int
    ) -> tuple[list[NotificationItem], int, int]:
        """Itens, total e não lidas consideram a autorização ATUAL, no mesmo snapshot."""
        with self._read() as tx:
            viewer = Viewer(user_id, tx.org.membership_of_user(user_id))
            rows, total, unread = tx.queries.notifications(NotificationSearch(
                viewer=viewer, kind=kind, unread_only=unread_only, page=page, per_page=per_page))
        return [NotificationItem(r.notification, self._summary_of(r)) for r in rows], total, unread

    def unread_count(self, user_id: str, kind: ScopeKind) -> int:
        with self._read() as tx:
            viewer = Viewer(user_id, tx.org.membership_of_user(user_id))
            return tx.queries.notifications(NotificationSearch(
                viewer=viewer, kind=kind, unread_only=True, page=1, per_page=1))[2]

    def mark_read(self, user_id: str, notification_id: str) -> NotificationItem:
        with self._unit() as tx:
            n = tx.notifications.get(notification_id)
            m = tx.org.membership_of_user(user_id)
            summary = self._summary(tx, user_id, m, n) if n is not None and n.recipient_id == user_id else None
            if n is None or summary is None:
                ops.raise_denial(NOT_FOUND)
            assert n is not None and summary is not None
            if n.read_at is None:
                n = replace(n, read_at=tx.now)
                tx.notifications.put(n)
            return NotificationItem(n, summary)

    def read_all(self, user_id: str, kind: ScopeKind) -> int:
        with self._unit() as tx:
            viewer = Viewer(user_id, tx.org.membership_of_user(user_id))
            ids = tx.queries.unread_ids(viewer, kind)            # só as visíveis com a autorização atual
            for nid in ids:
                n = tx.notifications.get(nid)
                if n is not None and n.read_at is None:
                    tx.notifications.put(replace(n, read_at=tx.now))
            return len(ids)
