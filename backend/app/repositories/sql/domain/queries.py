"""Consultas do domínio no PostgreSQL (implementa `app.repositories.queries.Queries`).

Autorização, filtros, busca, ordenação (com desempate determinístico) e paginação no SQL; total e
contadores em consultas próprias sobre o MESMO conjunto filtrado e no MESMO snapshot da unidade de
leitura (REPEATABLE READ READ ONLY). Página além da última → `items=[]` com total correto.

Equivalências com a memória: comparação sem maiúsculas via `lower()`; ordenação de títulos por
`lower(title) COLLATE "C"` (ordem de pontos de código, como o Python); UUIDs ordenam como o hex.
"""
from __future__ import annotations

import calendar
from datetime import date, time, timedelta

from sqlalchemy import Text, and_, case, cast, false, func, literal, or_, select, true

from app.db.tables import deadline_comments, deadline_history, deadlines, intimation_events, intimations, notifications
from app.domain.deadlines import ScopeKind
from app.repositories.queries import (
    DeadlineSearch,
    IntimationSearch,
    MonthSearch,
    NotificationRow,
    NotificationSearch,
    Viewer,
)
from app.repositories.sql.domain.mapping import (
    U,
    comment_out,
    deadline_out,
    history_out,
    intimation_event_out,
    intimation_out,
    notification_out,
    scope_filter,
)

PENDING = ("processing", "awaiting_review", "failed")


def _like(text_expr, needle: str):
    escaped = needle.lower().replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return func.lower(text_expr).like(f"%{escaped}%", escape="\\")


def readable_deadline(d, v: Viewer):
    personal = and_(d.c.scope_kind == "personal", d.c.owner_id == U(v.user_id))
    if not (v.office_id and v.can_read_office):
        return personal
    office = and_(d.c.scope_kind == "office", d.c.office_id == U(v.office_id),
                  true() if v.sees_all else d.c.responsible_id == U(v.user_id))
    return or_(personal, office)


def readable_intimation(i, linked, v: Viewer):
    personal = and_(i.c.scope_kind == "personal", i.c.owner_id == U(v.user_id))
    if not (v.office_id and v.can_read_office):
        return personal
    me = U(v.user_id)
    narrow = or_(i.c.created_by == me,
                 and_(i.c.status.in_(PENDING), i.c.suggested_responsible_id == me),
                 and_(i.c.status == "reviewed", linked.c.responsible_id == me))
    office = and_(i.c.scope_kind == "office", i.c.office_id == U(v.office_id), true() if v.sees_all else narrow)
    return or_(personal, office)


class SqlQueries:
    def __init__(self, ctx) -> None:
        self._c = ctx

    def _rows(self, stmt):
        return self._c.conn.execute(stmt).all()

    def _count(self, where_stmt) -> int:
        return self._c.conn.execute(select(func.count()).select_from(where_stmt.subquery())).scalar_one()

    # ------------------------------------------------------------ prazos
    def deadlines(self, c: DeadlineSearch):
        d = deadlines
        conds = [scope_filter(d, c.scope), readable_deadline(d, c.viewer)]
        if c.status:
            conds.append(d.c.status == c.status)
        if c.urgency:
            soon_end = c.today + timedelta(days=c.soon_days)
            conds.append(d.c.status == "open")
            conds.append({
                "overdue": d.c.due_date < c.today,
                "today": d.c.due_date == c.today,
                "soon": and_(d.c.due_date > c.today, d.c.due_date <= soon_end),
                "upcoming": d.c.due_date > soon_end,
            }.get(c.urgency, false()))
        if c.area:
            conds.append(func.lower(d.c.practice_area) == c.area.lower())
        if c.responsible_id:
            conds.append(d.c.responsible_id == U(c.responsible_id))
        if c.due_from:
            conds.append(d.c.due_date >= c.due_from)
        if c.due_to:
            conds.append(d.c.due_date <= c.due_to)
        if c.q:
            sep = literal(" ", Text)
            conds.append(_like(d.c.title + sep + d.c.case_number + sep + d.c.court + sep + d.c.practice_area, c.q))
        key = {
            "dueDate": d.c.due_date,
            "title": func.lower(d.c.title).collate("C"),
            "priority": case((d.c.priority == "high", 0), else_=1),
            "status": case((d.c.status == "open", 0), (d.c.status == "completed", 1), else_=2),
            "createdAt": d.c.created_at,
        }[c.sort]
        order = key.desc() if c.direction == "desc" else key.asc()
        filtered = select(d.c.id).where(*conds)
        total = self._count(filtered)
        self._c.checkpoint("query:after_count")       # testes: outra conexão confirma algo aqui
        rows = self._rows(select(d).where(*conds).order_by(order, d.c.id.asc())
                          .limit(c.per_page).offset((c.page - 1) * c.per_page))
        return [deadline_out(r) for r in rows], total

    def month(self, c: MonthSearch):
        d = deadlines
        first = date(c.year, c.month, 1)
        last = date(c.year, c.month, calendar.monthrange(c.year, c.month)[1])
        conds = [scope_filter(d, c.scope), readable_deadline(d, c.viewer), d.c.due_date.between(first, last)]
        if c.status:
            conds.append(d.c.status == c.status)
        counts = {r.due_date.isoformat(): r.n for r in self._rows(
            select(d.c.due_date, func.count().label("n")).where(*conds).group_by(d.c.due_date))}
        total = sum(counts.values())
        self._c.checkpoint("query:after_count")
        rows = self._rows(select(d).where(*conds).order_by(
            d.c.due_date, func.coalesce(d.c.agenda_time, time(23, 59, 59)), d.c.id
        ).limit(c.per_page).offset((c.page - 1) * c.per_page))
        return [deadline_out(r) for r in rows], total, counts

    def comments(self, deadline_id: str, page: int, per_page: int):
        t = deadline_comments
        where = t.c.deadline_id == U(deadline_id)
        total = self._count(select(t.c.id).where(where))
        rows = self._rows(select(t).where(where).order_by(t.c.seq).limit(per_page).offset((page - 1) * per_page))
        return [comment_out(r) for r in rows], total

    def history(self, deadline_id: str, page: int, per_page: int):
        t = deadline_history
        where = t.c.deadline_id == U(deadline_id)
        total = self._count(select(t.c.id).where(where))
        rows = self._rows(select(t).where(where).order_by(t.c.seq).limit(per_page).offset((page - 1) * per_page))
        return [history_out(r) for r in rows], total

    # ------------------------------------------------------------ intimações
    def intimations(self, c: IntimationSearch):
        i, linked = intimations, deadlines.alias("linked")
        conds = [scope_filter(i, c.scope), readable_intimation(i, linked, c.viewer),
                 i.c.status == c.status if c.status else i.c.status != "discarded"]
        if c.q:
            sep = literal(" ", Text)
            conds.append(_like(i.c.file_name + sep + func.coalesce(i.c.draft_title, "") + sep
                               + func.coalesce(i.c.draft_case_number, ""), c.q))
        src = i.outerjoin(linked, linked.c.id == i.c.deadline_id)
        total = self._count(select(i.c.id).select_from(src).where(*conds))
        rows = self._rows(select(i).select_from(src).where(*conds).order_by(i.c.created_at.desc(), i.c.id.asc())
                          .limit(c.per_page).offset((c.page - 1) * c.per_page))
        return [intimation_out(r) for r in rows], total

    def events(self, intimation_id: str, page: int, per_page: int):
        t = intimation_events
        where = t.c.intimation_id == U(intimation_id)
        total = self._count(select(t.c.id).where(where))
        rows = self._rows(select(t).where(where).order_by(t.c.seq).limit(per_page).offset((page - 1) * per_page))
        return [intimation_event_out(r) for r in rows], total

    # ------------------------------------------------------------ notificações
    def _visible(self, viewer: Viewer, kind: ScopeKind):
        n = notifications
        d, i, linked = deadlines.alias("d"), intimations.alias("i"), deadlines.alias("il")
        if kind == "personal":
            scope = and_(n.c.scope_kind == "personal", n.c.owner_id == U(viewer.user_id))
        elif viewer.office_id:
            scope = and_(n.c.scope_kind == "office", n.c.office_id == U(viewer.office_id))
        else:
            scope = false()
        src = n.outerjoin(d, d.c.id == n.c.deadline_id).outerjoin(i, i.c.id == n.c.intimation_id) \
            .outerjoin(linked, linked.c.id == i.c.deadline_id)
        readable = or_(and_(n.c.deadline_id.is_not(None), d.c.id.is_not(None), readable_deadline(d, viewer)),
                       and_(n.c.intimation_id.is_not(None), i.c.id.is_not(None),
                            readable_intimation(i, linked, viewer)))
        return src, [n.c.recipient_id == U(viewer.user_id), scope, readable]

    def notifications(self, c: NotificationSearch):
        n = notifications
        src, conds = self._visible(c.viewer, c.kind)
        totals = self._c.conn.execute(select(func.count(), func.count().filter(n.c.read_at.is_(None)))
                                      .select_from(src).where(*conds)).one()
        self._c.checkpoint("query:after_count")
        if c.unread_only:
            conds = [*conds, n.c.read_at.is_(None)]
        total = totals[1] if c.unread_only else totals[0]
        rows = self._rows(select(n).select_from(src).where(*conds).order_by(n.c.created_at.desc(), n.c.id.desc())
                          .limit(c.per_page).offset((c.page - 1) * c.per_page))
        items = [notification_out(r) for r in rows]
        d_ids = [U(x.resource_id) for x in items if x.resource_type == "deadline"]
        i_ids = [U(x.resource_id) for x in items if x.resource_type == "intimation"]
        ds = {r.id.hex: deadline_out(r) for r in self._rows(select(deadlines).where(deadlines.c.id.in_(d_ids)))} \
            if d_ids else {}
        its = {r.id.hex: intimation_out(r)
               for r in self._rows(select(intimations).where(intimations.c.id.in_(i_ids)))} if i_ids else {}
        out = [NotificationRow(x, ds.get(x.resource_id), its.get(x.resource_id)) for x in items]
        return out, total, totals[1]

    def unread_ids(self, viewer: Viewer, kind: ScopeKind) -> list[str]:
        n = notifications
        src, conds = self._visible(viewer, kind)
        rows = self._rows(select(n.c.id).select_from(src).where(*conds, n.c.read_at.is_(None))
                          .order_by(n.c.id))
        return [r.id.hex for r in rows]


_unused = (cast,)
