"""Conversão linha ↔ entidade de domínio (sem regras de negócio).

- IDs: uuid no banco ↔ hex de 32 caracteres no domínio/API; ator "system" ↔ NULL;
- escopo: (scope_kind, owner_id, office_id) ↔ `Scope`;
- colunas DERIVADAS gravadas pelo repositório: `deadlines.open_office_id` (só prazo aberto do
  escritório) e `intimations.suggested_open_office_id` (só pendência do escritório com sugerido),
  que alimentam as FKs diferidas de "responsável/sugerido ativo".
"""
from __future__ import annotations

import json
import uuid
from typing import Any

from sqlalchemy.engine import Row

from app.domain.deadlines import Comment, Deadline, HistoryEvent, Scope
from app.domain.intimations import (
    PENDING,
    SYSTEM_ACTOR,
    Draft,
    FileMeta,
    Intimation,
    IntimationEvent,
    Notification,
    Processing,
    Suggestion,
)
from app.domain.org import Invitation, JoinRequest, Membership, Office


def U(value: str | None) -> uuid.UUID | None:
    """hex → uuid (None se ausente ou inválido: tratado como inexistente)."""
    if value is None:
        return None
    try:
        return uuid.UUID(hex=value)
    except (ValueError, TypeError, AttributeError):
        return None


def H(value: uuid.UUID | None) -> str | None:
    return value.hex if value is not None else None


def actor_in(value: str) -> uuid.UUID | None:
    return None if value == SYSTEM_ACTOR else U(value)


def actor_out(value: uuid.UUID | None) -> str:
    return SYSTEM_ACTOR if value is None else value.hex


def scope_cols(scope: Scope) -> dict[str, Any]:
    return {"scope_kind": scope.kind, "owner_id": U(scope.owner_id), "office_id": U(scope.office_id)}


def scope_of(row: Row) -> Scope:
    if row.scope_kind == "personal":
        return Scope.personal(row.owner_id.hex)
    return Scope.office(row.office_id.hex)


def scope_filter(table, scope: Scope):
    if scope.kind == "personal":
        return (table.c.scope_kind == "personal") & (table.c.owner_id == U(scope.owner_id))
    return (table.c.scope_kind == "office") & (table.c.office_id == U(scope.office_id))


def _json(value: Any) -> Any:
    return json.loads(json.dumps(value, default=str))   # datas e afins viram texto (jsonb)


# ---------------------------------------------------------------- escritórios
def office_out(r: Row) -> Office:
    return Office(id=r.id.hex, name=r.name, created_by=r.created_by.hex, created_at=r.created_at, join_code=r.join_code)


def membership_out(r: Row) -> Membership:
    return Membership(user_id=r.user_id.hex, office_id=r.office_id.hex, role_label=r.role_label,
                      practice_areas=tuple(r.practice_areas), permissions=frozenset(r.permissions),
                      visibility=r.visibility, joined_at=r.joined_at)


def membership_cols(m: Membership) -> dict[str, Any]:
    return {"user_id": U(m.user_id), "office_id": U(m.office_id), "role_label": m.role_label,
            "practice_areas": list(m.practice_areas), "permissions": sorted(m.permissions),
            "visibility": m.visibility, "joined_at": m.joined_at}


def invitation_out(r: Row) -> Invitation:
    return Invitation(id=r.id.hex, office_id=r.office_id.hex, token_hash=r.token_hash, role_label=r.role_label,
                      created_by=r.created_by.hex, created_at=r.created_at, expires_at=r.expires_at,
                      status=r.status, closed_at=r.closed_at)


def invitation_cols(i: Invitation) -> dict[str, Any]:
    return {"id": U(i.id), "office_id": U(i.office_id), "token_hash": i.token_hash, "role_label": i.role_label,
            "created_by": U(i.created_by), "created_at": i.created_at, "expires_at": i.expires_at,
            "status": i.status, "closed_at": i.closed_at}


def request_out(r: Row) -> JoinRequest:
    return JoinRequest(id=r.id.hex, office_id=r.office_id.hex, user_id=r.user_id.hex, created_at=r.created_at,
                       status=r.status, decided_at=r.decided_at, decided_by=H(r.decided_by))


def request_cols(q: JoinRequest) -> dict[str, Any]:
    return {"id": U(q.id), "office_id": U(q.office_id), "user_id": U(q.user_id), "created_at": q.created_at,
            "status": q.status, "decided_at": q.decided_at, "decided_by": U(q.decided_by)}


# ---------------------------------------------------------------- prazos
def deadline_out(r: Row) -> Deadline:
    return Deadline(id=r.id.hex, scope=scope_of(r), title=r.title, case_number=r.case_number, court=r.court,
                    practice_area=r.practice_area, responsible_id=r.responsible_id.hex, status=r.status,
                    priority=r.priority, start_date=r.start_date, due_date=r.due_date,
                    counting_mode=r.counting_mode, duration=r.duration, reviewed=r.reviewed,
                    agenda_time=r.agenda_time, created_by=r.created_by.hex, created_at=r.created_at,
                    updated_at=r.updated_at, version=r.version)


def deadline_cols(d: Deadline) -> dict[str, Any]:
    open_office = U(d.scope.office_id) if d.status == "open" and d.scope.kind == "office" else None
    return {"id": U(d.id), **scope_cols(d.scope), "title": d.title, "case_number": d.case_number,
            "court": d.court, "practice_area": d.practice_area, "responsible_id": U(d.responsible_id),
            "status": d.status, "priority": d.priority, "start_date": d.start_date, "due_date": d.due_date,
            "counting_mode": d.counting_mode, "duration": d.duration, "reviewed": d.reviewed,
            "agenda_time": d.agenda_time, "created_by": U(d.created_by), "created_at": d.created_at,
            "updated_at": d.updated_at, "version": d.version, "open_office_id": open_office}


def comment_out(r: Row) -> Comment:
    return Comment(id=r.id.hex, deadline_id=r.deadline_id.hex, author_id=r.author_id.hex, text=r.text,
                   created_at=r.created_at)


def history_out(r: Row) -> HistoryEvent:
    return HistoryEvent(id=r.id.hex, deadline_id=r.deadline_id.hex, actor_id=actor_out(r.actor_id),
                        action=r.action, at=r.at, details=dict(r.details or {}))


# ---------------------------------------------------------------- intimações
def intimation_out(r: Row) -> Intimation:
    draft = Draft(title=r.draft_title, case_number=r.draft_case_number, court=r.draft_court,
                  practice_area=r.draft_practice_area, start_date=r.draft_start_date, due_date=r.draft_due_date,
                  counting_mode=r.draft_counting_mode, duration=r.draft_duration, priority=r.draft_priority,
                  agenda_time=r.draft_agenda_time)
    suggestion = Suggestion(source=r.suggestion["source"], fields=dict(r.suggestion.get("fields", {}))) \
        if r.suggestion else None
    return Intimation(
        id=r.id.hex, scope=scope_of(r),
        file=FileMeta(name=r.file_name, size_bytes=r.file_size_bytes, content_type=r.file_content_type,
                      storage=r.file_storage),
        received_at=r.received_at, status=r.status,
        processing=Processing(status=r.processing_status, attempts=r.processing_attempts,
                              failure_code=r.processing_failure_code),
        draft=draft, created_by=r.created_by.hex, created_at=r.created_at, updated_at=r.updated_at,
        suggested_responsible_id=H(r.suggested_responsible_id), suggestion=suggestion,
        deadline_id=H(r.deadline_id), closed_at=r.closed_at, version=r.version,
    )


def intimation_cols(i: Intimation) -> dict[str, Any]:
    d = i.draft
    pending_office = i.status in PENDING and i.scope.kind == "office" and i.suggested_responsible_id is not None
    return {
        "id": U(i.id), **scope_cols(i.scope), "file_name": i.file.name, "file_size_bytes": i.file.size_bytes,
        "file_content_type": i.file.content_type, "file_storage": i.file.storage, "received_at": i.received_at,
        "status": i.status, "processing_status": i.processing.status, "processing_attempts": i.processing.attempts,
        "processing_failure_code": i.processing.failure_code, "draft_title": d.title,
        "draft_case_number": d.case_number, "draft_court": d.court, "draft_practice_area": d.practice_area,
        "draft_start_date": d.start_date, "draft_due_date": d.due_date, "draft_counting_mode": d.counting_mode,
        "draft_duration": d.duration, "draft_priority": d.priority, "draft_agenda_time": d.agenda_time,
        "suggestion": _json({"source": i.suggestion.source, "fields": i.suggestion.fields}) if i.suggestion else None,
        "suggested_responsible_id": U(i.suggested_responsible_id),
        "suggested_open_office_id": U(i.scope.office_id) if pending_office else None,
        "deadline_id": U(i.deadline_id), "created_by": U(i.created_by), "created_at": i.created_at,
        "updated_at": i.updated_at, "closed_at": i.closed_at, "version": i.version,
    }


def intimation_event_out(r: Row) -> IntimationEvent:
    return IntimationEvent(id=r.id.hex, intimation_id=r.intimation_id.hex, actor_id=actor_out(r.actor_id),
                           action=r.action, at=r.at, details=dict(r.details or {}))


# ---------------------------------------------------------------- notificações
def notification_out(r: Row) -> Notification:
    resource = r.deadline_id if r.deadline_id is not None else r.intimation_id
    return Notification(id=r.id.hex, recipient_id=r.recipient_id.hex, scope=scope_of(r), kind=r.kind,
                        resource_type="deadline" if r.deadline_id is not None else "intimation",
                        resource_id=resource.hex, event_id=r.event_id.hex, created_at=r.created_at,
                        read_at=r.read_at)


def notification_cols(n: Notification) -> dict[str, Any]:
    return {"id": U(n.id), "recipient_id": U(n.recipient_id), **scope_cols(n.scope), "kind": n.kind,
            "deadline_id": U(n.resource_id) if n.resource_type == "deadline" else None,
            "intimation_id": U(n.resource_id) if n.resource_type == "intimation" else None,
            "event_id": U(n.event_id), "created_at": n.created_at, "read_at": n.read_at}


def json_details(details: dict[str, Any]) -> Any:
    return _json(details)
