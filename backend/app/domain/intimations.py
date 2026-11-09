"""Intimações e notificações internas (Etapa 5, sem ORM).

Fronteira com etapas futuras:
- ARQUIVO: só metadados DECLARADOS pelo usuário; `file.storage` é sempre "not_stored".
  Nenhum PDF é recebido, armazenado ou lido nesta etapa.
- PROCESSAMENTO: `processing.status = "not_available"`; não há extração, OCR nem IA.
  Estados `processing`/`failed` e sugestões com `source="processing"` estão preparados
  para uma porta futura e só são acionados por operação interna (sem rota HTTP).

Revisão humana é obrigatória: um prazo só nasce da confirmação explícita, com todos os
dados finais informados pelo usuário.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, datetime, time
from typing import Any, Literal

from app.domain.deadlines import CountingMode, Priority, Scope

IntimationStatus = Literal["processing", "awaiting_review", "failed", "reviewed", "discarded"]
PENDING: frozenset[str] = frozenset({"processing", "awaiting_review", "failed"})
ProcessingStatus = Literal["not_available", "pending", "completed", "failed"]
NotificationKind = Literal["deadline_assigned", "intimation_assigned"]
ResourceType = Literal["deadline", "intimation"]
SYSTEM_ACTOR = "system"


@dataclass(frozen=True)
class FileMeta:
    name: str
    size_bytes: int
    content_type: str
    storage: Literal["not_stored"] = "not_stored"


@dataclass(frozen=True)
class Processing:
    status: ProcessingStatus = "not_available"
    attempts: int = 0
    failure_code: str | None = None


@dataclass(frozen=True)
class Draft:
    """Rascunho de revisão (todos os campos opcionais). Nunca completa a confirmação sozinho."""

    title: str | None = None
    case_number: str | None = None
    court: str | None = None
    practice_area: str | None = None
    start_date: date | None = None
    due_date: date | None = None
    counting_mode: CountingMode | None = None
    duration: int | None = None
    priority: Priority | None = None
    agenda_time: time | None = None


@dataclass(frozen=True)
class Suggestion:
    """Sugestão vinda de processamento futuro (exige revisão humana). Nunca gerada nesta etapa."""

    source: Literal["processing"]
    fields: dict[str, Any]


@dataclass(frozen=True)
class Intimation:
    id: str
    scope: Scope
    file: FileMeta
    received_at: date
    status: IntimationStatus
    processing: Processing
    draft: Draft
    created_by: str
    created_at: datetime
    updated_at: datetime
    suggested_responsible_id: str | None = None
    suggestion: Suggestion | None = None
    deadline_id: str | None = None
    closed_at: datetime | None = None  # revisada ou descartada
    version: int = 1

    @property
    def pending(self) -> bool:
        return self.status in PENDING


@dataclass(frozen=True)
class IntimationEvent:
    id: str
    intimation_id: str
    actor_id: str
    action: str  # registered | draft_updated | responsible_suggested | confirmed | discarded
    #              | transferred | responsible_reassigned | processing_* | retry_requested
    at: datetime
    details: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class Notification:
    """Notificação interna individual. NÃO guarda título, processo nem conteúdo: o resumo é
    projetado na leitura, só se o destinatário ainda puder acessar o recurso."""

    id: str
    recipient_id: str
    scope: Scope
    kind: NotificationKind
    resource_type: ResourceType
    resource_id: str
    event_id: str
    created_at: datetime
    read_at: datetime | None = None
