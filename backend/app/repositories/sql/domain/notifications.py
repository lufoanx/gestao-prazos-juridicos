"""Notificações internas (implementa `NotificationTransaction`).

Deduplicação por `UNIQUE (recipient_id, event_id)` com `ON CONFLICT DO NOTHING`; a política da
caixa é aplicada na preparação da unidade, sob bloqueio consultivo por destinatário.
"""
from __future__ import annotations

from sqlalchemy import select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert

from app.db.tables import notifications
from app.domain.intimations import Notification
from app.repositories.sql.domain.mapping import U, notification_cols, notification_out


class SqlNotificationTransaction:
    def __init__(self, ctx) -> None:
        self._c = ctx

    @property
    def now(self):
        return self._c.now

    def get(self, notification_id: str) -> Notification | None:
        nid = U(notification_id)
        if nid is None:
            return None
        stmt = select(notifications).where(notifications.c.id == nid)
        row = self._c.conn.execute(stmt if self._c.read_only else stmt.with_for_update()).first()
        return notification_out(row) if row else None

    def of_recipient(self, recipient_id: str) -> list[Notification]:
        rows = self._c.conn.execute(select(notifications).where(notifications.c.recipient_id == U(recipient_id))
                                    .order_by(notifications.c.created_at.desc(), notifications.c.id))
        return [notification_out(r) for r in rows]

    def add(self, n: Notification) -> bool:
        """Devolve False se a notificação já existia (mesmo destinatário e evento)."""
        self._c.require_write()
        stmt = pg_insert(notifications).values(**notification_cols(n)).on_conflict_do_nothing(
            constraint="uq_notifications_recipient_id_event_id").returning(notifications.c.id)
        inserted = self._c.conn.execute(stmt).first() is not None
        if inserted:
            self._c.recipients.add(U(n.recipient_id))
        return inserted

    def put(self, n: Notification) -> None:
        self._c.require_write()
        self._c.conn.execute(update(notifications).where(notifications.c.id == U(n.id)).values(read_at=n.read_at))
