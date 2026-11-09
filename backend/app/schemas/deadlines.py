"""DTOs da Etapa 4 (camelCase; campos extras proibidos; datas civis estritas)."""
from __future__ import annotations

import re
import unicodedata
from datetime import date, datetime, time
from typing import Annotated, Any, Literal

from pydantic import AfterValidator, BeforeValidator, Field, StrictBool, model_validator

from app.schemas.auth import _Input, _Output
from app.schemas.org import UserRef

DATE_MIN, DATE_MAX = date(2000, 1, 1), date(2100, 12, 31)
_DATE_RE = re.compile(r"^[0-9]{4}-[0-9]{2}-[0-9]{2}$")
_TIME_RE = re.compile(r"^([01][0-9]|2[0-3]):[0-5][0-9]$")


def parse_civil_date(value: object) -> date:
    """YYYY-MM-DD estrito, data civil real entre 2000-01-01 e 2100-12-31 (sem fuso)."""
    if not isinstance(value, str) or len(value) != 10 or not _DATE_RE.match(value):
        raise ValueError("Data deve estar no formato YYYY-MM-DD.")
    try:
        d = date.fromisoformat(value)
    except ValueError:
        raise ValueError("Data inexistente.") from None
    if not (DATE_MIN <= d <= DATE_MAX):
        raise ValueError("Data fora do intervalo permitido (2000-01-01 a 2100-12-31).")
    return d


def _time(value: object) -> time:
    if not isinstance(value, str) or not _TIME_RE.match(value):
        raise ValueError("Horário deve estar no formato HH:MM.")
    return time.fromisoformat(value)


def _text(min_len: int, max_len: int, field: str):  # type: ignore[no-untyped-def]
    def check(value: str) -> str:
        text = " ".join(value.split())
        if not (min_len <= len(text) <= max_len):
            raise ValueError(f"{field} deve ter de {min_len} a {max_len} caracteres.")
        if any(unicodedata.category(c).startswith("C") for c in text):
            raise ValueError(f"{field} contém caracteres inválidos.")
        return text
    return check


def _comment_text(value: str) -> str:
    text = value.strip()
    if not (1 <= len(text) <= 2000):
        raise ValueError("Comentário deve ter de 1 a 2000 caracteres.")
    if any(unicodedata.category(c).startswith("C") and c not in "\n\t" for c in text):
        raise ValueError("Comentário contém caracteres inválidos.")
    return text


CivilDate = Annotated[date, BeforeValidator(parse_civil_date)]
AgendaTime = Annotated[time, BeforeValidator(_time)]
Title = Annotated[str, Field(max_length=400), AfterValidator(_text(3, 200, "Título"))]
CaseNumber = Annotated[str, Field(max_length=100), AfterValidator(_text(3, 50, "Número do processo"))]
Court = Annotated[str, Field(max_length=240), AfterValidator(_text(2, 120, "Tribunal/vara"))]
PracticeArea = Annotated[str, Field(max_length=120), AfterValidator(_text(1, 60, "Área de atuação"))]
Duration = Annotated[int, Field(ge=1, le=3650, strict=True)]
Version = Annotated[int, Field(ge=1, strict=True)]
CommentText = Annotated[str, Field(max_length=4000), AfterValidator(_comment_text)]
StatusName = Literal["open", "completed", "cancelled"]
PriorityName = Literal["normal", "high"]
CountingName = Literal["business", "calendar"]
ScopeName = Literal["personal", "office"]


class CreateDeadlineRequest(_Input):
    scope: ScopeName
    title: Title
    case_number: CaseNumber
    court: Court
    practice_area: PracticeArea
    responsible_id: UserRef | None = None
    priority: PriorityName = "normal"
    start_date: CivilDate
    due_date: CivilDate
    counting_mode: CountingName
    duration: Duration
    agenda_time: AgendaTime | None = None
    reviewed: StrictBool = True


class UpdateDeadlineRequest(_Input):
    """`version` obrigatório. Não aceita id, scope, ownerId, officeId, status, createdBy nem datas de evento."""

    version: Version
    title: Title | None = None
    case_number: CaseNumber | None = None
    court: Court | None = None
    practice_area: PracticeArea | None = None
    responsible_id: UserRef | None = None
    priority: PriorityName | None = None
    start_date: CivilDate | None = None
    due_date: CivilDate | None = None
    counting_mode: CountingName | None = None
    duration: Duration | None = None
    agenda_time: AgendaTime | None = None   # null explícito remove o horário
    reviewed: StrictBool | None = None

    @model_validator(mode="after")
    def _check(self) -> UpdateDeadlineRequest:
        provided = self.model_fields_set - {"version"}
        if not provided:
            raise ValueError("Informe ao menos um campo para alterar.")
        for name in provided - {"agenda_time"}:
            if getattr(self, name) is None:
                raise ValueError(f"{name} não pode ser nulo.")
        return self

    def changes(self) -> dict[str, Any]:
        return {name: getattr(self, name) for name in self.model_fields_set - {"version"}}


class StatusRequest(_Input):
    version: Version
    status: StatusName
    responsible_id: UserRef | None = None


class TransferRequest(_Input):
    """Consentimentos são booleanos ESTRITOS (`true`; não aceita 1 nem "true")."""

    version: Version
    office_id: UserRef
    confirm_sharing: StrictBool
    share_linked_intimation: StrictBool = False

    @model_validator(mode="after")
    def _consent(self) -> TransferRequest:
        if self.confirm_sharing is not True:
            raise ValueError("confirmSharing deve ser true.")
        return self


class CommentRequest(_Input):
    text: CommentText


# ------------------------------------------------------------------ saídas
class ScopeView(_Output):
    kind: str
    owner_id: str | None = None
    office_id: str | None = None


class UrgencyView(_Output):
    level: str
    days: int


class DeadlineView(_Output):
    id: str
    scope: ScopeView
    title: str
    case_number: str
    court: str
    practice_area: str
    responsible_id: str
    status: str
    priority: str
    start_date: date
    due_date: date
    counting_mode: str
    duration: int
    reviewed: bool
    agenda_time: str | None
    created_by: str
    created_at: datetime
    updated_at: datetime
    version: int
    urgency: UrgencyView | None


class DeadlinePage(_Output):
    items: list[DeadlineView]
    page: int
    per_page: int
    total: int
    page_count: int
    reference_date: date


class TransferResponse(_Output):
    deadline: DeadlineView
    notice: str


class CommentView(_Output):
    id: str
    deadline_id: str
    author_id: str
    text: str
    created_at: datetime


class CommentPage(_Output):
    items: list[CommentView]
    page: int
    per_page: int
    total: int


class HistoryView(_Output):
    id: str
    actor_id: str
    action: str
    at: datetime
    details: dict[str, Any]


class HistoryPage(_Output):
    items: list[HistoryView]
    page: int
    per_page: int
    total: int


class CalendarResponse(_Output):
    year: int
    month: int
    reference_date: date
    timezone: str
    items: list[DeadlineView]
    counts_by_day: dict[str, int]
    page: int
    per_page: int
    total: int
    page_count: int
    has_next_page: bool
    next_page: int | None
