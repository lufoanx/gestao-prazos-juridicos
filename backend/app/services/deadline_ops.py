"""Operações sobre uma unidade de trabalho JÁ ABERTA (Etapas 4 e 5).

Fonte única das regras de criação, reatribuição, histórico e notificação de prazos,
reutilizada por `DeadlineService`, `IntimationService` e pela porta de responsabilidades.
Nenhuma função aqui abre transação (sem aninhamento): todas recebem a `UnitTransaction`.
"""
from __future__ import annotations

import uuid
from dataclasses import replace
from datetime import date, datetime, time
from typing import Any

from app.core.errors import AppError
from app.domain.deadlines import Deadline, HistoryEvent, Scope, ScopeKind
from app.domain.intimations import Notification, NotificationKind, ResourceType
from app.domain.org import Membership
from app.policies import deadlines as policy
from app.policies.org import NOT_FOUND, Denial
from app.repositories.deadlines import UnitTransaction


def to_json(value: Any) -> Any:
    if isinstance(value, (date, datetime)):
        return value.isoformat()
    if isinstance(value, time):
        return value.strftime("%H:%M")
    return value


def raise_denial(denial: Denial) -> None:
    raise AppError(denial.status, denial.code, denial.message)


def active_responsible(tx: UnitTransaction, scope: Scope, user_id: str) -> None:
    """Responsável válido NESTA transação: dono (pessoal) ou membro ativo do escritório."""
    if scope.kind == "personal":
        if user_id != scope.owner_id:
            raise_denial(policy.RESPONSIBLE_INVALID)
        return
    m = tx.org.membership_of_user(user_id)
    if m is None or m.office_id != scope.office_id:
        raise_denial(policy.RESPONSIBLE_INVALID)


def is_active_member(tx: UnitTransaction, office_id: str | None, user_id: str | None) -> bool:
    m = tx.org.membership_of_user(user_id) if user_id else None
    return m is not None and m.office_id == office_id


def record_event(tx: UnitTransaction, d: Deadline, actor_id: str, action: str, **details: Any) -> HistoryEvent:
    event = HistoryEvent(id=uuid.uuid4().hex, deadline_id=d.id, actor_id=actor_id, action=action, at=tx.now,
                         details=details)
    tx.deadlines.add_history(event)
    return event


def notify(
    tx: UnitTransaction, *, recipient_id: str, actor_id: str, kind: NotificationKind,
    resource_type: ResourceType, resource_id: str, scope: Scope, event_id: str,
) -> None:
    """Notificação interna individual. Não notifica o autor da ação nem o ambiente pessoal
    (Etapa 5). Não guarda conteúdo. Deduplicada por (destinatário, evento)."""
    if recipient_id == actor_id or scope.kind != "office":
        return
    tx.notifications.add(Notification(
        id=uuid.uuid4().hex, recipient_id=recipient_id, scope=scope, kind=kind,
        resource_type=resource_type, resource_id=resource_id, event_id=event_id, created_at=tx.now,
    ))
    tx.checkpoint("notify")


def create_deadline(
    tx: UnitTransaction, actor_id: str, kind: ScopeKind, data: dict[str, Any], *, source: dict[str, Any] | None = None
) -> Deadline:
    """Regras de criação da Etapa 4: permissões, atribuição, responsável ativo, datas."""
    m: Membership | None = tx.org.membership_of_user(actor_id)
    if (d := policy.check_create(actor_id, m, kind)):
        raise_denial(d)
    scope = Scope.personal(actor_id) if kind == "personal" else Scope.office(m.office_id)  # type: ignore[union-attr]
    # Âncora do escopo de destino ANTES do relógio e da revalidação do responsável.
    tx.lock_anchors(office_ids=(scope.office_id,) if scope.office_id else (),
                    user_ids=(scope.owner_id,) if scope.owner_id else ())
    responsible = data.get("responsible_id") or actor_id
    if (d := policy.check_assignment(actor_id, m, kind, responsible)):
        raise_denial(d)
    active_responsible(tx, scope, responsible)
    if data["due_date"] < data["start_date"]:
        raise AppError(422, "invalid_dates", "O vencimento não pode ser anterior ao início.")
    deadline = Deadline(
        id=uuid.uuid4().hex, scope=scope, title=data["title"], case_number=data["case_number"],
        court=data["court"], practice_area=data["practice_area"], responsible_id=responsible,
        status="open", priority=data.get("priority") or "normal", start_date=data["start_date"],
        due_date=data["due_date"], counting_mode=data["counting_mode"], duration=data["duration"],
        reviewed=data.get("reviewed", True), agenda_time=data.get("agenda_time"),
        created_by=actor_id, created_at=tx.now, updated_at=tx.now,
    )
    tx.deadlines.put(deadline)
    details: dict[str, Any] = {"responsibleId": responsible}
    if source:
        details["source"] = source
    event = record_event(tx, deadline, actor_id, "created", **details)
    notify(tx, recipient_id=responsible, actor_id=actor_id, kind="deadline_assigned", resource_type="deadline",
           resource_id=deadline.id, scope=scope, event_id=event.id)
    return deadline


def reassign_event(tx: UnitTransaction, d: Deadline, actor_id: str, from_id: str, to_id: str, reason: str) -> None:
    event = record_event(tx, d, actor_id, "reassigned", fromResponsibleId=from_id, toResponsibleId=to_id,
                         reason=reason)
    notify(tx, recipient_id=to_id, actor_id=actor_id, kind="deadline_assigned", resource_type="deadline",
           resource_id=d.id, scope=d.scope, event_id=event.id)


def reassign_deadline(tx: UnitTransaction, d: Deadline, to_id: str, actor_id: str, reason: str) -> Deadline:
    updated = replace(d, responsible_id=to_id, version=d.version + 1, updated_at=tx.now)
    tx.deadlines.put(updated)
    tx.checkpoint("reassign:deadline")
    reassign_event(tx, updated, actor_id, d.responsible_id, to_id, reason)
    tx.checkpoint("reassign:history")
    return updated


# Chaves de detalhes de eventos que referenciam recursos protegidos → tipo do recurso.
PROTECTED_REFS: dict[str, str] = {
    "deadlineId": "deadline",
    "intimationId": "intimation",
    "linkedIntimationId": "intimation",
}


def can_read_deadline_id(tx: UnitTransaction, actor_id: str, m: Membership | None, deadline_id: str) -> bool:
    d = tx.deadlines.get(deadline_id)
    return d is not None and policy.can_read(actor_id, m, d)


def can_read_intimation_id(tx: UnitTransaction, actor_id: str, m: Membership | None, intimation_id: str) -> bool:
    from app.policies import intimations as in_policy

    i = tx.intimations.get(intimation_id)
    if i is None:
        return False
    linked = tx.deadlines.get(i.deadline_id) if i.deadline_id else None
    return in_policy.can_read(actor_id, m, i, linked.responsible_id if linked else None)


def visible_ref(tx: UnitTransaction, actor_id: str, m: Membership | None, kind: str, ref: str) -> str | None:
    """Projeção ÚNICA de referências protegidas (detalhe, listagem e históricos)."""
    readable = can_read_deadline_id if kind == "deadline" else can_read_intimation_id
    return ref if readable(tx, actor_id, m, ref) else None


def project_details(tx: UnitTransaction, actor_id: str, m: Membership | None, details: Any) -> Any:
    """Cópia dos detalhes de um evento com referências protegidas ocultas conforme a autorização
    ATUAL. O vínculo continua indicado (`<chave>Hidden: true`); o evento armazenado não muda."""
    if isinstance(details, dict):
        out: dict[str, Any] = {}
        for key, value in details.items():
            kind = PROTECTED_REFS.get(key)
            if kind and isinstance(value, str):
                visible = visible_ref(tx, actor_id, m, kind, value)
                out[key] = visible
                if visible is None:
                    out[f"{key}Hidden"] = True
            else:
                out[key] = project_details(tx, actor_id, m, value)
        return out
    if isinstance(details, list):
        return [project_details(tx, actor_id, m, v) for v in details]
    return details


def readable_deadline(tx: UnitTransaction, actor_id: str, deadline_id: str) -> tuple[Deadline, Membership | None]:
    m = tx.org.membership_of_user(actor_id)
    d = tx.deadlines.get(deadline_id)
    if d is None or not policy.can_read(actor_id, m, d):
        raise_denial(NOT_FOUND)
    assert d is not None
    return d, m
