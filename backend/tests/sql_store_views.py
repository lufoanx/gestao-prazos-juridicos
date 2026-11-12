"""Visões SOMENTE LEITURA do PostgreSQL com a interface de dicionário dos armazenamentos em memória.

Usadas apenas nos testes (modo PRAZOAI_TEST_STORAGE=postgres) para que as MESMAS asserções de estado
("nada mudou", "vínculo criado", "token só como hash") rodem nas duas implementações. Cada acesso lê
o banco numa conexão nova (estado confirmado). Mecânicas exclusivas da memória (`lock`, `state`,
`last_purge`) NÃO são imitadas: testes que dependem delas são classificados como `memory_only`.
"""
from __future__ import annotations

from sqlalchemy import select

from app.db.tables import (
    deadline_comments,
    deadline_history,
    deadlines,
    intimation_events,
    intimations,
    invitations,
    join_requests,
    memberships,
    notifications,
    offices,
)
from app.repositories.sql.domain.mapping import (
    comment_out,
    deadline_out,
    history_out,
    intimation_event_out,
    intimation_out,
    invitation_out,
    membership_out,
    notification_out,
    office_out,
    request_out,
)


class _View:
    FIELDS: tuple[str, ...] = ()

    def __init__(self, engine) -> None:
        self._engine = engine

    def snapshot(self) -> dict:
        """Conteúdo integral (dados e índices derivados) para comparar rollback."""
        return {name: getattr(self, name) for name in self.FIELDS}

    def _rows(self, stmt):
        with self._engine.connect() as conn:
            return conn.execute(stmt).all()


def _group(pairs) -> dict:
    out: dict = {}
    for key, value in pairs:
        out.setdefault(key, []).append(value)
    return out


class OrgStoreView(_View):
    FIELDS = ("offices", "office_by_code", "membership_by_user", "members_by_office", "invitations",
              "invitation_by_hash", "invitations_by_office", "requests", "requests_by_office", "requests_by_user")
    @property
    def offices(self):
        return {r.id.hex: office_out(r) for r in self._rows(select(offices))}

    @property
    def office_by_code(self):
        return {r.join_code: r.id.hex for r in self._rows(select(offices))}

    @property
    def membership_by_user(self):
        return {r.user_id.hex: membership_out(r) for r in self._rows(select(memberships))}

    @property
    def members_by_office(self):
        return {k: frozenset(v) for k, v in _group((r.office_id.hex, r.user_id.hex)
                                                   for r in self._rows(select(memberships))).items()}

    @property
    def invitations(self):
        return {r.id.hex: invitation_out(r) for r in self._rows(select(invitations))}

    @property
    def invitation_by_hash(self):
        return {r.token_hash: r.id.hex for r in self._rows(select(invitations))}

    @property
    def invitations_by_office(self):
        return {k: frozenset(v) for k, v in _group((r.office_id.hex, r.id.hex)
                                                   for r in self._rows(select(invitations))).items()}

    @property
    def requests(self):
        return {r.id.hex: request_out(r) for r in self._rows(select(join_requests))}

    @property
    def requests_by_office(self):
        return {k: frozenset(v) for k, v in _group((r.office_id.hex, r.id.hex)
                                                   for r in self._rows(select(join_requests))).items()}

    @property
    def requests_by_user(self):
        return {k: frozenset(v) for k, v in _group((r.user_id.hex, r.id.hex)
                                                   for r in self._rows(select(join_requests))).items()}


class DeadlineStoreView(_View):
    FIELDS = ("deadlines", "by_scope", "comments", "history")
    @property
    def deadlines(self):
        return {r.id.hex: deadline_out(r) for r in self._rows(select(deadlines))}

    @property
    def by_scope(self):
        return {k: frozenset(v) for k, v in _group((d.scope.key, d.id) for d in self.deadlines.values()).items()}

    @property
    def comments(self):
        return {k: tuple(v) for k, v in _group(
            (r.deadline_id.hex, comment_out(r)) for r in self._rows(select(deadline_comments).order_by(
                deadline_comments.c.seq))).items()}

    @property
    def history(self):
        return {k: tuple(v) for k, v in _group(
            (r.deadline_id.hex, history_out(r)) for r in self._rows(select(deadline_history).order_by(
                deadline_history.c.seq))).items()}


class IntimationStoreView(_View):
    FIELDS = ("intimations", "by_deadline", "events")
    @property
    def intimations(self):
        return {r.id.hex: intimation_out(r) for r in self._rows(select(intimations))}

    @property
    def by_deadline(self):
        return {r.deadline_id.hex: r.id.hex for r in self._rows(select(intimations)) if r.deadline_id}

    @property
    def events(self):
        return {k: tuple(v) for k, v in _group(
            (r.intimation_id.hex, intimation_event_out(r)) for r in self._rows(select(intimation_events).order_by(
                intimation_events.c.seq))).items()}


class NotificationStoreView(_View):
    FIELDS = ("notifications", "by_recipient", "dedupe")

    @property
    def notifications(self):
        return {r.id.hex: notification_out(r) for r in self._rows(select(notifications))}

    @property
    def by_recipient(self):
        return {k: frozenset(v) for k, v in _group((n.recipient_id, n.id) for n in self.notifications.values()).items()}

    @property
    def dedupe(self):
        return {(n.recipient_id, n.event_id): n.id for n in self.notifications.values()}


def attach(app) -> None:
    """Liga as visões a uma app em STORAGE=postgres (somente testes)."""
    org = getattr(app.state, "org", None)
    if org is None or org.store is not None:
        return
    engine = org.unit_of_work.engine
    org.store = OrgStoreView(engine)
    org.deadline_store = DeadlineStoreView(engine)
    uow = org.unit_of_work
    uow.org_store, uow.deadline_store = org.store, org.deadline_store
    uow.intimation_store, uow.notification_store = IntimationStoreView(engine), NotificationStoreView(engine)
