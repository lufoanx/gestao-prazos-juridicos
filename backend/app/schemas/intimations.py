"""DTOs da Etapa 5 (camelCase; campos extras proibidos)."""
from __future__ import annotations

import unicodedata
from datetime import date, datetime
from typing import Annotated, Any, Literal

from pydantic import AfterValidator, Field, model_validator

from app.schemas.auth import _Input, _Output
from app.schemas.deadlines import (
    AgendaTime,
    CaseNumber,
    CivilDate,
    CountingName,
    Court,
    DeadlineView,
    Duration,
    PracticeArea,
    PriorityName,
    ScopeView,
    Title,
    Version,
)
from app.schemas.org import UserRef

MAX_FILE_BYTES = 10 * 1024 * 1024  # mesmo limite declarado pelo protótipo


def _file_name(value: str) -> str:
    name = value.strip()
    if not (1 <= len(name) <= 255):
        raise ValueError("Nome do arquivo deve ter de 1 a 255 caracteres.")
    if any(unicodedata.category(c).startswith("C") for c in name) or "/" in name or "\\" in name:
        raise ValueError("Nome do arquivo contém caracteres inválidos.")
    if not name.lower().endswith(".pdf"):
        raise ValueError("Somente arquivos PDF (.pdf).")
    return name


FileName = Annotated[str, Field(max_length=300), AfterValidator(_file_name)]
FileSize = Annotated[int, Field(ge=1, le=MAX_FILE_BYTES, strict=True)]


class RegisterIntimationRequest(_Input):
    """Registra METADADOS DECLARADOS. Nenhum arquivo é enviado ou armazenado nesta etapa."""

    scope: Literal["personal", "office"]
    file_name: FileName
    size_bytes: FileSize
    content_type: Literal["application/pdf"]
    received_at: CivilDate
    suggested_responsible_id: UserRef | None = None


class UpdateDraftRequest(_Input):
    """`version` obrigatório; `null` limpa um campo do rascunho. Só em `awaiting_review`."""

    version: Version
    title: Title | None = None
    case_number: CaseNumber | None = None
    court: Court | None = None
    practice_area: PracticeArea | None = None
    start_date: CivilDate | None = None
    due_date: CivilDate | None = None
    counting_mode: CountingName | None = None
    duration: Duration | None = None
    priority: PriorityName | None = None
    agenda_time: AgendaTime | None = None
    suggested_responsible_id: UserRef | None = None

    @model_validator(mode="after")
    def _at_least_one(self) -> UpdateDraftRequest:
        if not (self.model_fields_set - {"version"}):
            raise ValueError("Informe ao menos um campo para alterar.")
        return self

    def draft_changes(self) -> dict[str, Any]:
        return {k: getattr(self, k) for k in self.model_fields_set - {"version", "suggested_responsible_id"}}


class ConfirmIntimationRequest(_Input):
    """Dados FINAIS revisados pelo usuário (todos explícitos) + `version` da intimação.

    O servidor não completa campos a partir do rascunho.
    """

    version: Version
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


class VersionRequest(_Input):
    version: Version


class FileView(_Output):
    name: str
    size_bytes: int
    content_type: str
    storage: str


class ProcessingView(_Output):
    status: str
    attempts: int
    failure_code: str | None = None


class DraftView(_Output):
    title: str | None = None
    case_number: str | None = None
    court: str | None = None
    practice_area: str | None = None
    start_date: date | None = None
    due_date: date | None = None
    counting_mode: str | None = None
    duration: int | None = None
    priority: str | None = None
    agenda_time: str | None = None


class SuggestionView(_Output):
    source: str
    fields: dict[str, Any]


class IntimationView(_Output):
    id: str
    scope: ScopeView
    file: FileView
    received_at: date
    status: str
    processing: ProcessingView
    draft: DraftView
    suggestion: SuggestionView | None
    suggested_responsible_id: str | None
    deadline_id: str | None          # só se o solicitante puder ler o prazo vinculado
    linked: bool                     # há prazo vinculado (sem revelar o id a quem não o lê)
    created_by: str
    created_at: datetime
    updated_at: datetime
    closed_at: datetime | None
    version: int


class ConfirmResponse(_Output):
    intimation: IntimationView
    deadline: DeadlineView
    created: bool  # true → 201 (primeira confirmação); false → 200 (repetição sem efeito)


class IntimationPage(_Output):
    items: list[IntimationView]
    page: int
    per_page: int
    total: int


class IntimationEventView(_Output):
    id: str
    actor_id: str
    action: str
    at: datetime
    details: dict[str, Any]


class IntimationHistoryPage(_Output):
    items: list[IntimationEventView]
    page: int
    per_page: int
    total: int


class NotificationView(_Output):
    id: str
    kind: str
    resource_type: str
    resource_id: str
    summary: dict[str, Any]
    created_at: datetime
    read_at: datetime | None


class NotificationPage(_Output):
    items: list[NotificationView]
    page: int
    per_page: int
    total: int
    unread: int
    retention_policy: str


class UnreadCountView(_Output):
    unread: int


class ReadAllView(_Output):
    marked: int
