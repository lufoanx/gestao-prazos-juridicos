"""Prazos, comentários e histórico no PostgreSQL (implementa `DeadlineTransaction`)."""
from __future__ import annotations

from sqlalchemy import insert, select
from sqlalchemy.dialects.postgresql import insert as pg_insert

from app.db.tables import deadline_comments, deadline_history, deadlines
from app.domain.deadlines import Comment, Deadline, HistoryEvent, Scope
from app.repositories.sql.domain.mapping import (
    U,
    actor_in,
    comment_out,
    deadline_cols,
    deadline_out,
    history_out,
    json_details,
    scope_filter,
)

ORDER_IN_SCOPE = (deadlines.c.id,)


class SqlDeadlineTransaction:
    def __init__(self, ctx) -> None:
        self._c = ctx

    @property
    def now(self):
        return self._c.now

    def get(self, deadline_id: str) -> Deadline | None:
        """Identificação preliminar do escopo → âncora → releitura com bloqueio da linha."""
        did = U(deadline_id)
        if did is None:
            return None
        for _ in range(3):
            pre = self._c.conn.execute(select(deadlines.c.scope_kind, deadlines.c.owner_id, deadlines.c.office_id)
                                       .where(deadlines.c.id == did)).first()
            if pre is None:
                return None
            self._c.anchor_row_scope(pre)
            stmt = select(deadlines).where(deadlines.c.id == did)
            row = self._c.conn.execute(stmt if self._c.read_only else stmt.with_for_update()).first()
            if row is None:
                return None
            if self._c.read_only or (row.scope_kind, row.owner_id, row.office_id) == tuple(pre):
                return deadline_out(row)
        return deadline_out(row)                                        # pragma: no cover

    def in_scope(self, scope: Scope) -> list[Deadline]:
        self._c.anchor_scope(scope)
        rows = self._c.conn.execute(select(deadlines).where(scope_filter(deadlines, scope)).order_by(*ORDER_IN_SCOPE))
        return [deadline_out(r) for r in rows]

    def count_in_scope(self, scope: Scope) -> int:
        from sqlalchemy import func

        self._c.anchor_scope(scope)
        return self._c.conn.execute(select(func.count()).select_from(deadlines).where(
            scope_filter(deadlines, scope))).scalar_one()

    def open_in_office_for(self, office_id: str, user_id: str) -> list[Deadline]:
        oid, uid = U(office_id), U(user_id)
        self._c.anchor_office(oid)
        stmt = select(deadlines).where(deadlines.c.scope_kind == "office", deadlines.c.office_id == oid,
                                       deadlines.c.status == "open", deadlines.c.responsible_id == uid
                                       ).order_by(deadlines.c.id)
        rows = self._c.conn.execute(stmt if self._c.read_only else stmt.with_for_update())
        return [deadline_out(r) for r in rows]

    def put(self, deadline: Deadline) -> None:
        self._c.require_write()
        cols = deadline_cols(deadline)
        self._c.anchor_scope(deadline.scope)
        update_cols = {k: v for k, v in cols.items() if k not in ("id", "created_by", "created_at")}
        self._c.conn.execute(pg_insert(deadlines).values(**cols).on_conflict_do_update(
            index_elements=["id"], set_=update_cols))
        self._c.touched_deadlines.add(cols["id"])
        self._c.touched_deadline_scopes.add(deadline.scope.key)
        self._c.scopes[deadline.scope.key] = deadline.scope

    def comments(self, deadline_id: str) -> tuple[Comment, ...]:
        rows = self._c.conn.execute(select(deadline_comments).where(deadline_comments.c.deadline_id == U(deadline_id))
                                    .order_by(deadline_comments.c.seq))           # ordem de inserção
        return tuple(comment_out(r) for r in rows)

    def add_comment(self, comment: Comment) -> None:
        self._c.require_write()
        self._c.conn.execute(insert(deadline_comments).values(
            id=U(comment.id), deadline_id=U(comment.deadline_id), author_id=U(comment.author_id), text=comment.text,
            created_at=comment.created_at))
        self._c.touched_deadlines.add(U(comment.deadline_id))

    def history(self, deadline_id: str) -> tuple[HistoryEvent, ...]:
        rows = self._c.conn.execute(select(deadline_history).where(deadline_history.c.deadline_id == U(deadline_id))
                                    .order_by(deadline_history.c.seq))            # ordem de inserção
        return tuple(history_out(r) for r in rows)

    def add_history(self, event: HistoryEvent) -> None:
        self._c.require_write()
        self._c.conn.execute(insert(deadline_history).values(
            id=U(event.id), deadline_id=U(event.deadline_id), actor_id=actor_in(event.actor_id), action=event.action,
            at=event.at, details=json_details(event.details)))
        self._c.touched_deadlines.add(U(event.deadline_id))
