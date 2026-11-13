"""Fábricas de linhas para os testes de manutenção (Core direto; datas controladas)."""
from __future__ import annotations

import uuid
from datetime import date, datetime, timedelta, timezone

from sqlalchemy import insert

from app.db.tables import (
    auth_sessions,
    auth_used_refresh_hashes,
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
    password_reset_tokens,
    users,
)
from app.maintenance import MaintenanceLimits, RetentionPolicy

T0 = datetime(2026, 11, 1, 12, 0, tzinfo=timezone.utc)
DAY = timedelta(days=1)
POLICY = RetentionPolicy(org_closed_retention=10 * DAY, intimation_discard_retention=10 * DAY,
                         notification_read_retention=10 * DAY)
LIMITS = MaintenanceLimits(batch_size=50, max_batches=100, lock_timeout_ms=200, statement_timeout_ms=5000)


def _hex() -> str:
    return uuid.uuid4().hex


def user(c) -> uuid.UUID:
    u = uuid.uuid4()
    c.execute(insert(users).values(id=u, name="U", email=f"{u.hex[:10]}@x.com", password_hash="h", created_at=T0))
    return u


def office(c, owner) -> uuid.UUID:
    o = uuid.uuid4()
    c.execute(insert(offices).values(id=o, name="Escritório", created_by=owner, created_at=T0,
                                     join_code=uuid.uuid4().hex[:10].upper().translate(str.maketrans("ILOU", "2345"))))
    c.execute(insert(memberships).values(user_id=owner, office_id=o, role_label="Sócia", permissions=["office.manage"],
                                         visibility="all", joined_at=T0))
    return o


def session(c, u, *, expires, revoked=None, hashes=2) -> uuid.UUID:
    s = uuid.uuid4()
    c.execute(insert(auth_sessions).values(id=s, user_id=u, created_at=expires - 2 * DAY, expires_at=expires,
                                           current_refresh_hash=_hex() + _hex(), credential_version=0,
                                           revoked_at=revoked))
    for _ in range(hashes):
        c.execute(insert(auth_used_refresh_hashes).values(refresh_hash=_hex() + _hex(), session_id=s, used_at=T0))
    return s


def reset(c, u, *, expires, used=None, invalidated=None) -> str:
    h = _hex() + _hex()
    c.execute(insert(password_reset_tokens).values(token_hash=h, user_id=u, created_at=T0 - DAY, expires_at=expires,
                                                   used_at=used, invalidated_at=invalidated))
    return h


def invitation(c, o, owner, *, status="pending", expires, closed=None) -> uuid.UUID:
    i = uuid.uuid4()
    c.execute(insert(invitations).values(id=i, office_id=o, token_hash=_hex() + _hex(), role_label="Membro",
                                         created_by=owner, created_at=T0 - 30 * DAY, expires_at=expires,
                                         status=status, closed_at=closed))
    return i


def request(c, o, u, *, status="pending", decided=None) -> uuid.UUID:
    r = uuid.uuid4()
    c.execute(insert(join_requests).values(id=r, office_id=o, user_id=u, created_at=T0 - 30 * DAY, status=status,
                                           decided_at=decided))
    return r


def intimation(c, o, author, *, status="awaiting_review", closed=None, events=2) -> uuid.UUID:
    i = uuid.uuid4()
    c.execute(insert(intimations).values(
        id=i, scope_kind="office", office_id=o, file_name="i.pdf", file_size_bytes=10,
        file_content_type="application/pdf", received_at=date(2026, 10, 1), status=status, created_by=author,
        created_at=T0 - 30 * DAY, updated_at=T0 - 30 * DAY, closed_at=closed))
    for _ in range(events):
        c.execute(insert(intimation_events).values(id=uuid.uuid4(), intimation_id=i, actor_id=author,
                                                   action="registered", at=T0 - 30 * DAY))
    return i


def notification(c, recipient, o, intimation_id, *, read=None) -> uuid.UUID:
    n = uuid.uuid4()
    c.execute(insert(notifications).values(id=n, recipient_id=recipient, scope_kind="office", office_id=o,
                                           kind="intimation_assigned", intimation_id=intimation_id,
                                           event_id=uuid.uuid4(), created_at=T0 - 30 * DAY, read_at=read))
    return n


def deadline_with_children(c, o, owner) -> uuid.UUID:
    d = uuid.uuid4()
    c.execute(insert(deadlines).values(
        id=d, scope_kind="office", office_id=o, title="T", case_number="N", court="C", practice_area="A",
        responsible_id=owner, status="completed", priority="normal", start_date=date(2020, 1, 1),
        due_date=date(2020, 1, 2), counting_mode="business", duration=1, reviewed=True, created_by=owner,
        created_at=T0 - 3000 * DAY, updated_at=T0 - 3000 * DAY))
    c.execute(insert(deadline_comments).values(id=uuid.uuid4(), deadline_id=d, author_id=owner, text="c",
                                               created_at=T0 - 3000 * DAY))
    c.execute(insert(deadline_history).values(id=uuid.uuid4(), deadline_id=d, actor_id=owner, action="created",
                                              at=T0 - 3000 * DAY))
    return d
