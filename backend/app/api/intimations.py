"""Rotas /intimations e /notifications (Etapa 5)."""
from __future__ import annotations

from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Path, Query, Request, Response, status
from fastapi.responses import JSONResponse

from app.api.deadlines import deadline_view, get_deadline_service
from app.api.deps import CurrentUser
from app.core.errors import AppError
from app.domain.intimations import IntimationEvent
from app.schemas.deadlines import ScopeView
from app.schemas.intimations import (
    ConfirmIntimationRequest,
    ConfirmResponse,
    DraftView,
    FileView,
    IntimationEventView,
    IntimationHistoryPage,
    IntimationPage,
    IntimationView,
    NotificationPage,
    NotificationView,
    ProcessingView,
    ReadAllView,
    RegisterIntimationRequest,
    SuggestionView,
    UnreadCountView,
    UpdateDraftRequest,
    VersionRequest,
)
from app.services.deadline_service import DeadlineService
from app.services.intimation_service import IntimationResult, IntimationService
from app.services.notification_service import NotificationItem, NotificationService

INBOX_POLICY = (
    "Notificações lidas são removidas após o período de retenção. Ao exceder o limite da caixa, "
    "removem-se primeiro as lidas mais antigas e depois as não lidas mais antigas. "
    "Notificações de recursos que você não pode mais acessar ficam ocultas."
)


def _intimations(request: Request) -> IntimationService:
    svc = getattr(request.app.state, "intimations", None)
    if svc is None:
        raise AppError(404, "http_error", "Not Found")
    return svc


def _notifications(request: Request) -> NotificationService:
    svc = getattr(request.app.state, "notifications", None)
    if svc is None:
        raise AppError(404, "http_error", "Not Found")
    return svc


Intimations = Annotated[IntimationService, Depends(_intimations)]
Notifications = Annotated[NotificationService, Depends(_notifications)]
Deadlines = Annotated[DeadlineService, Depends(get_deadline_service)]
Id = Annotated[str, Path(min_length=1, max_length=64, pattern=r"^[A-Za-z0-9_-]+$")]
PageQ = Annotated[int, Query(ge=1, le=100_000)]
PerPageQ = Annotated[int, Query(alias="perPage", ge=1, le=100)]
ScopeQ = Annotated[Literal["personal", "office"], Query()]

router = APIRouter(tags=["intimations"])


def intimation_view(r: IntimationResult) -> IntimationView:
    i, d = r.intimation, r.intimation.draft
    return IntimationView(
        id=i.id, scope=ScopeView(kind=i.scope.kind, owner_id=i.scope.owner_id, office_id=i.scope.office_id),
        file=FileView(name=i.file.name, size_bytes=i.file.size_bytes, content_type=i.file.content_type,
                      storage=i.file.storage),
        received_at=i.received_at, status=i.status,
        processing=ProcessingView(status=i.processing.status, attempts=i.processing.attempts,
                                  failure_code=i.processing.failure_code),
        draft=DraftView(title=d.title, case_number=d.case_number, court=d.court, practice_area=d.practice_area,
                        start_date=d.start_date, due_date=d.due_date, counting_mode=d.counting_mode,
                        duration=d.duration, priority=d.priority,
                        agenda_time=d.agenda_time.strftime("%H:%M") if d.agenda_time else None),
        suggestion=SuggestionView(source=i.suggestion.source, fields=i.suggestion.fields) if i.suggestion else None,
        suggested_responsible_id=i.suggested_responsible_id, deadline_id=r.visible_deadline_id,
        linked=i.deadline_id is not None, created_by=i.created_by, created_at=i.created_at,
        updated_at=i.updated_at, closed_at=i.closed_at, version=i.version,
    )


def event_view(e: IntimationEvent) -> IntimationEventView:
    return IntimationEventView(id=e.id, actor_id=e.actor_id, action=e.action, at=e.at, details=e.details)


def notification_view(item: NotificationItem) -> NotificationView:
    n = item.notification
    return NotificationView(id=n.id, kind=n.kind, resource_type=n.resource_type, resource_id=n.resource_id,
                            summary=item.summary, created_at=n.created_at, read_at=n.read_at)


@router.post("/intimations", status_code=status.HTTP_201_CREATED, response_model=IntimationView)
def register(body: RegisterIntimationRequest, current: CurrentUser, svc: Intimations) -> IntimationView:
    meta = {"file_name": body.file_name, "size_bytes": body.size_bytes, "content_type": body.content_type,
            "received_at": body.received_at}
    return intimation_view(svc.register(current.user.id, body.scope, meta, body.suggested_responsible_id))


@router.get("/intimations", response_model=IntimationPage)
def list_intimations(
    current: CurrentUser, svc: Intimations, scope: ScopeQ,
    status_filter: Annotated[
        Literal["processing", "awaiting_review", "failed", "reviewed", "discarded"] | None, Query(alias="status")
    ] = None,
    q: Annotated[str | None, Query(max_length=100)] = None,
    page: PageQ = 1, per_page: PerPageQ = 20,
) -> IntimationPage:
    items, total = svc.list_intimations(current.user.id, scope, status_filter, (q or "").strip() or None,
                                        page, per_page)
    return IntimationPage(items=[intimation_view(r) for r in items], page=page, per_page=per_page, total=total)


@router.get("/intimations/{intimation_id}", response_model=IntimationView)
def get_intimation(intimation_id: Id, current: CurrentUser, svc: Intimations) -> IntimationView:
    return intimation_view(svc.get(current.user.id, intimation_id))


@router.patch("/intimations/{intimation_id}", response_model=IntimationView)
def update_draft(intimation_id: Id, body: UpdateDraftRequest, current: CurrentUser, svc: Intimations) -> IntimationView:
    provided = "suggested_responsible_id" in body.model_fields_set
    r = svc.update_draft(current.user.id, intimation_id, body.version, body.draft_changes(),
                         body.suggested_responsible_id, provided)
    return intimation_view(r)


@router.post("/intimations/{intimation_id}/confirm", status_code=status.HTTP_201_CREATED,
             response_model=ConfirmResponse, responses={200: {"model": ConfirmResponse}})
def confirm(
    intimation_id: Id, body: ConfirmIntimationRequest, current: CurrentUser, svc: Intimations, deadlines: Deadlines
) -> Response:
    data = body.model_dump(exclude={"version"})
    result = svc.confirm(current.user.id, intimation_id, body.version, data)
    payload = ConfirmResponse(
        intimation=intimation_view(result.intimation), deadline=deadline_view(result.deadline, deadlines),
        created=result.created,
    )
    # 201 na primeira confirmação; 200 em repetição (sem novo efeito).
    return JSONResponse(status_code=201 if result.created else 200,
                        content=payload.model_dump(mode="json", by_alias=True))


@router.post("/intimations/{intimation_id}/discard", response_model=IntimationView)
def discard(intimation_id: Id, body: VersionRequest, current: CurrentUser, svc: Intimations) -> IntimationView:
    return intimation_view(svc.discard(current.user.id, intimation_id, body.version))


@router.post("/intimations/{intimation_id}/retry", response_model=IntimationView)
def retry(intimation_id: Id, body: VersionRequest, current: CurrentUser, svc: Intimations) -> IntimationView:
    return intimation_view(svc.retry(current.user.id, intimation_id, body.version))


@router.get("/intimations/{intimation_id}/history", response_model=IntimationHistoryPage)
def history(
    intimation_id: Id, current: CurrentUser, svc: Intimations, page: PageQ = 1, per_page: PerPageQ = 50
) -> IntimationHistoryPage:
    items, total = svc.history(current.user.id, intimation_id, page, per_page)
    return IntimationHistoryPage(items=[event_view(e) for e in items], page=page, per_page=per_page, total=total)


# ------------------------------------------------------------------ notificações
@router.get("/notifications", response_model=NotificationPage, tags=["notifications"])
def list_notifications(
    current: CurrentUser, svc: Notifications, scope: ScopeQ,
    unread_only: Annotated[bool, Query(alias="unreadOnly")] = False,
    page: PageQ = 1, per_page: PerPageQ = 20,
) -> NotificationPage:
    items, total, unread = svc.list_notifications(current.user.id, scope, unread_only, page, per_page)
    return NotificationPage(items=[notification_view(i) for i in items], page=page, per_page=per_page,
                            total=total, unread=unread, retention_policy=INBOX_POLICY)


@router.get("/notifications/unread-count", response_model=UnreadCountView, tags=["notifications"])
def unread_count(current: CurrentUser, svc: Notifications, scope: ScopeQ) -> UnreadCountView:
    return UnreadCountView(unread=svc.unread_count(current.user.id, scope))


@router.post("/notifications/{notification_id}/read", response_model=NotificationView, tags=["notifications"])
def mark_read(notification_id: Id, current: CurrentUser, svc: Notifications) -> NotificationView:
    return notification_view(svc.mark_read(current.user.id, notification_id))


@router.post("/notifications/read-all", response_model=ReadAllView, tags=["notifications"])
def read_all(current: CurrentUser, svc: Notifications, scope: ScopeQ) -> ReadAllView:
    return ReadAllView(marked=svc.read_all(current.user.id, scope))
