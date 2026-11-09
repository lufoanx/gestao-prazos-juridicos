"""Rotas /deadlines e /calendar (Etapa 4)."""
from __future__ import annotations

from datetime import date
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Path, Query, Request, status

from app.api.deps import CurrentUser
from app.core.errors import AppError
from app.domain.deadlines import Comment, Deadline, HistoryEvent
from app.schemas.deadlines import (
    CalendarResponse,
    CommentPage,
    CommentRequest,
    CommentView,
    CreateDeadlineRequest,
    DeadlinePage,
    DeadlineView,
    HistoryPage,
    HistoryView,
    ScopeView,
    StatusRequest,
    TransferRequest,
    TransferResponse,
    UpdateDeadlineRequest,
    UrgencyView,
    parse_civil_date,
)
from app.services.deadline_service import SHARING_NOTICE, DeadlineService, ListQuery


def get_deadline_service(request: Request) -> DeadlineService:
    container = getattr(request.app.state, "deadlines", None)
    if container is None:
        raise AppError(404, "http_error", "Not Found")
    return container


Service = Annotated[DeadlineService, Depends(get_deadline_service)]
Id = Annotated[str, Path(min_length=1, max_length=64, pattern=r"^[A-Za-z0-9_-]+$")]
PageQ = Annotated[int, Query(ge=1, le=100_000)]
ScopeQ = Annotated[Literal["personal", "office"], Query()]

router = APIRouter(tags=["deadlines"])


def deadline_view(d: Deadline, service: DeadlineService, today: date | None = None) -> DeadlineView:
    today = today or service.today()
    u = service.urgency(d, today)
    return DeadlineView(
        id=d.id,
        scope=ScopeView(kind=d.scope.kind, owner_id=d.scope.owner_id, office_id=d.scope.office_id),
        title=d.title, case_number=d.case_number, court=d.court, practice_area=d.practice_area,
        responsible_id=d.responsible_id, status=d.status, priority=d.priority,
        start_date=d.start_date, due_date=d.due_date, counting_mode=d.counting_mode, duration=d.duration,
        reviewed=d.reviewed, agenda_time=d.agenda_time.strftime("%H:%M") if d.agenda_time else None,
        created_by=d.created_by, created_at=d.created_at, updated_at=d.updated_at, version=d.version,
        urgency=UrgencyView(**u) if u else None,
    )


def comment_view(c: Comment) -> CommentView:
    return CommentView(id=c.id, deadline_id=c.deadline_id, author_id=c.author_id, text=c.text, created_at=c.created_at)


def history_view(e: HistoryEvent) -> HistoryView:
    return HistoryView(id=e.id, actor_id=e.actor_id, action=e.action, at=e.at, details=e.details)


def _optional_date(value: str | None, field: str) -> date | None:
    if value is None:
        return None
    try:
        return parse_civil_date(value)
    except ValueError as exc:
        from fastapi.exceptions import RequestValidationError

        raise RequestValidationError([{"type": "value_error", "loc": ("query", field), "msg": str(exc)}]) from None


@router.post("/deadlines", status_code=status.HTTP_201_CREATED, response_model=DeadlineView)
def create_deadline(body: CreateDeadlineRequest, current: CurrentUser, service: Service) -> DeadlineView:
    data = body.model_dump(exclude={"scope"})
    data["start_date"], data["due_date"] = body.start_date, body.due_date
    return deadline_view(service.create(current.user.id, body.scope, data), service)


@router.get("/deadlines", response_model=DeadlinePage)
def list_deadlines(
    current: CurrentUser,
    service: Service,
    scope: ScopeQ,
    q: Annotated[str | None, Query(max_length=100)] = None,
    status_filter: Annotated[Literal["open", "completed", "cancelled"] | None, Query(alias="status")] = None,
    urgency: Annotated[Literal["overdue", "today", "soon", "upcoming"] | None, Query()] = None,
    area: Annotated[str | None, Query(max_length=60)] = None,
    responsible_id: Annotated[
        str | None, Query(alias="responsibleId", max_length=64, pattern=r"^[A-Za-z0-9_-]+$")
    ] = None,
    due_from: Annotated[str | None, Query(alias="dueFrom", max_length=10)] = None,
    due_to: Annotated[str | None, Query(alias="dueTo", max_length=10)] = None,
    sort: Annotated[Literal["dueDate", "title", "priority", "status", "createdAt"], Query()] = "dueDate",
    direction: Annotated[Literal["asc", "desc"], Query(alias="dir")] = "asc",
    page: PageQ = 1,
    per_page: Annotated[int, Query(alias="perPage", ge=1, le=100)] = 20,
) -> DeadlinePage:
    query = ListQuery(
        scope=scope, q=q.strip() or None if q else None, status=status_filter, urgency=urgency,
        area=area.strip() or None if area else None, responsible_id=responsible_id,
        due_from=_optional_date(due_from, "dueFrom"), due_to=_optional_date(due_to, "dueTo"),
        sort=sort, direction=direction, page=page, per_page=per_page,
    )
    result, today = service.list_deadlines(current.user.id, query)
    return DeadlinePage(
        items=[deadline_view(d, service, today) for d in result.items], page=result.page,
        per_page=result.per_page, total=result.total, page_count=result.page_count, reference_date=today,
    )


@router.get("/deadlines/{deadline_id}", response_model=DeadlineView)
def get_deadline(deadline_id: Id, current: CurrentUser, service: Service) -> DeadlineView:
    return deadline_view(service.get(current.user.id, deadline_id), service)


@router.patch("/deadlines/{deadline_id}", response_model=DeadlineView)
def update_deadline(
    deadline_id: Id, body: UpdateDeadlineRequest, current: CurrentUser, service: Service
) -> DeadlineView:
    return deadline_view(service.update(current.user.id, deadline_id, body.version, body.changes()), service)


@router.post("/deadlines/{deadline_id}/status", response_model=DeadlineView)
def change_status(deadline_id: Id, body: StatusRequest, current: CurrentUser, service: Service) -> DeadlineView:
    d = service.change_status(current.user.id, deadline_id, body.version, body.status, body.responsible_id)
    return deadline_view(d, service)


@router.post("/deadlines/{deadline_id}/transfer", response_model=TransferResponse)
def transfer(deadline_id: Id, body: TransferRequest, current: CurrentUser, service: Service) -> TransferResponse:
    d = service.transfer(current.user.id, deadline_id, body.version, body.office_id, body.share_linked_intimation)
    return TransferResponse(deadline=deadline_view(d, service), notice=SHARING_NOTICE)


@router.post("/deadlines/{deadline_id}/comments", status_code=status.HTTP_201_CREATED, response_model=CommentView)
def add_comment(deadline_id: Id, body: CommentRequest, current: CurrentUser, service: Service) -> CommentView:
    return comment_view(service.add_comment(current.user.id, deadline_id, body.text))


@router.get("/deadlines/{deadline_id}/comments", response_model=CommentPage)
def list_comments(
    deadline_id: Id, current: CurrentUser, service: Service, page: PageQ = 1,
    per_page: Annotated[int, Query(alias="perPage", ge=1, le=100)] = 50,
) -> CommentPage:
    items, total = service.comments(current.user.id, deadline_id, page, per_page)
    return CommentPage(items=[comment_view(c) for c in items], page=page, per_page=per_page, total=total)


@router.get("/deadlines/{deadline_id}/history", response_model=HistoryPage)
def history(
    deadline_id: Id, current: CurrentUser, service: Service, page: PageQ = 1,
    per_page: Annotated[int, Query(alias="perPage", ge=1, le=100)] = 50,
) -> HistoryPage:
    items, total = service.history(current.user.id, deadline_id, page, per_page)
    return HistoryPage(items=[history_view(e) for e in items], page=page, per_page=per_page, total=total)


@router.get("/calendar", response_model=CalendarResponse)
def calendar(
    request: Request,
    current: CurrentUser,
    service: Service,
    scope: ScopeQ,
    year: Annotated[int, Query(ge=2000, le=2100)],
    month: Annotated[int, Query(ge=1, le=12)],
    status_filter: Annotated[Literal["open", "completed", "cancelled"] | None, Query(alias="status")] = None,
    page: PageQ = 1,
    per_page: Annotated[int, Query(alias="perPage", ge=1, le=500)] = 500,
) -> CalendarResponse:
    result, counts, today = service.calendar(current.user.id, scope, year, month, status_filter, page, per_page)
    has_next = page < result.page_count and result.total > page * per_page
    return CalendarResponse(
        year=year, month=month, reference_date=today, timezone=service.timezone_name,
        items=[deadline_view(d, service, today) for d in result.items], counts_by_day=counts,
        page=page, per_page=per_page, total=result.total, page_count=result.page_count,
        has_next_page=has_next, next_page=page + 1 if has_next else None,
    )
