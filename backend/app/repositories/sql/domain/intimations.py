"""Intimações (somente metadados), rascunhos, eventos e vínculo com prazo (implementa `IntimationTransaction`)."""
from __future__ import annotations

from datetime import datetime

from sqlalchemy import delete, insert, select
from sqlalchemy.dialects.postgresql import insert as pg_insert

from app.db.tables import file_cleanup, intimation_events, intimations
from app.domain.deadlines import Scope
from app.domain.intimations import Intimation, IntimationEvent
from app.repositories.sql.domain.mapping import (
    U,
    actor_in,
    intimation_cols,
    intimation_event_out,
    intimation_out,
    json_details,
    scope_filter,
)


class SqlIntimationTransaction:
    def __init__(self, ctx) -> None:
        self._c = ctx

    @property
    def now(self):
        return self._c.now

    def _locked(self, where) -> Intimation | None:
        for _ in range(3):
            pre = self._c.conn.execute(select(intimations.c.id, intimations.c.scope_kind, intimations.c.owner_id,
                                              intimations.c.office_id).where(where)).first()
            if pre is None:
                return None
            self._c.anchor_row_scope(pre)
            stmt = select(intimations).where(intimations.c.id == pre.id)
            row = self._c.conn.execute(stmt if self._c.read_only else stmt.with_for_update()).first()
            if row is None:
                return None
            if self._c.read_only or (row.scope_kind, row.owner_id, row.office_id) == tuple(pre)[1:]:
                return intimation_out(row)
        return intimation_out(row)                                      # pragma: no cover

    def get(self, intimation_id: str) -> Intimation | None:
        iid = U(intimation_id)
        return self._locked(intimations.c.id == iid) if iid else None

    def by_deadline(self, deadline_id: str) -> Intimation | None:
        did = U(deadline_id)
        return self._locked(intimations.c.deadline_id == did) if did else None

    def in_scope(self, scope: Scope) -> list[Intimation]:
        self._c.anchor_scope(scope)
        rows = self._c.conn.execute(select(intimations).where(scope_filter(intimations, scope))
                                    .order_by(intimations.c.id))
        return [intimation_out(r) for r in rows]

    def put(self, intimation: Intimation) -> None:
        self._c.require_write()
        cols = intimation_cols(intimation)
        self._c.anchor_scope(intimation.scope)
        update_cols = {k: v for k, v in cols.items() if k not in ("id", "created_by", "created_at")}
        self._c.conn.execute(pg_insert(intimations).values(**cols).on_conflict_do_update(
            index_elements=["id"], set_=update_cols))
        self._c.touched_intimations.add(cols["id"])
        self._c.touched_intimation_scopes.add(intimation.scope.key)
        self._c.scopes[intimation.scope.key] = intimation.scope

    def events(self, intimation_id: str) -> tuple[IntimationEvent, ...]:
        rows = self._c.conn.execute(select(intimation_events).where(
            intimation_events.c.intimation_id == U(intimation_id)).order_by(intimation_events.c.seq))
        return tuple(intimation_event_out(r) for r in rows)

    def add_event(self, event: IntimationEvent) -> None:
        self._c.require_write()
        self._c.conn.execute(insert(intimation_events).values(
            id=U(event.id), intimation_id=U(event.intimation_id), actor_id=actor_in(event.actor_id),
            action=event.action, at=event.at, details=json_details(event.details)))
        self._c.touched_intimations.add(U(event.intimation_id))

    # ------------------------------------------------------------------ arquivos (0004)
    def reserve_file(self, blob_key: str, not_before: datetime) -> None:
        self._c.require_write()
        self._c.conn.execute(insert(file_cleanup).values(blob_key=blob_key, reason="upload_pending",
                                                          not_before=not_before))

    def release_file_reservation(self, blob_key: str) -> bool:
        """Remove a reserva (mesma transação que publica o arquivo). False: a limpeza já a consumiu."""
        self._c.require_write()
        r = self._c.conn.execute(delete(file_cleanup).where(file_cleanup.c.blob_key == blob_key,
                                                             file_cleanup.c.reason == "upload_pending"))
        return r.rowcount == 1

    def claim_file_reservation(self, blob_key: str) -> bool:
        """True se a reserva PENDENTE ainda existe — então a publicação NÃO foi confirmada (ela consome a
        reserva na mesma transação). A linha fica bloqueada até o fim desta transação: nem a publicação
        nem a limpeza decidem sobre a mesma chave ao mesmo tempo."""
        self._c.require_write()
        row = self._c.conn.execute(select(file_cleanup.c.blob_key).where(
            file_cleanup.c.blob_key == blob_key, file_cleanup.c.reason == "upload_pending").with_for_update()).first()
        return row is not None

    def drop_file_reservation(self, blob_key: str) -> None:
        self._c.require_write()
        self._c.conn.execute(delete(file_cleanup).where(file_cleanup.c.blob_key == blob_key,
                                                        file_cleanup.c.reason == "upload_pending"))
