"""Intimações: registro de metadados, rascunho, revisão humana obrigatória, confirmação,
descarte e processamento futuro (Etapa 5).

Toda operação roda na unidade de trabalho composta (escritórios → prazos → intimações →
notificações), com o instante lido depois dos locks. A confirmação reutiliza as regras de
criação de prazo da Etapa 4 (`deadline_ops.create_deadline`) DENTRO da mesma unidade — sem
transação aninhada — e publica intimação revisada, prazo, vínculo, históricos e
notificações juntos.

Ordem das verificações: leitura (404) → permissões e regras de atribuição (403) → versão
(409 `version_conflict`) → estado/regras (409/422).
"""
from __future__ import annotations

import uuid
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass, replace
from typing import Any

from app.core.clock import Clock
from app.core.errors import AppError
from app.core.logging import get_logger
from app.domain.deadlines import Deadline, Scope, ScopeKind
from app.domain.intimations import (
    SYSTEM_ACTOR,
    Draft,
    FileMeta,
    Intimation,
    IntimationEvent,
    Processing,
    Suggestion,
)
from app.domain.org import Membership
from app.policies import deadlines as dl_policy
from app.policies import intimations as policy
from app.policies.org import NOT_FOUND
from app.repositories.deadlines import UnitTransaction
from app.repositories.deadlines_memory import CapacityError
from app.repositories.unit_of_work import MemoryUnitOfWork
from app.services import deadline_ops as ops
from app.services.processing_port import ProcessingNotAvailable, ProcessingPort

logger = get_logger("prazoai.intimations")

_DRAFT_FIELDS = tuple(Draft.__dataclass_fields__)
_CAMEL = {"case_number": "caseNumber", "practice_area": "practiceArea", "start_date": "startDate",
          "due_date": "dueDate", "counting_mode": "countingMode", "agenda_time": "agendaTime"}


@dataclass(frozen=True)
class IntimationResult:
    intimation: Intimation
    visible_deadline_id: str | None  # só preenchido se o solicitante puder ler o prazo vinculado


@dataclass(frozen=True)
class ConfirmResult:
    intimation: IntimationResult
    deadline: Deadline
    created: bool


class IntimationService:
    def __init__(
        self, *, unit_of_work: MemoryUnitOfWork, clock: Clock, processing: ProcessingPort | None = None
    ) -> None:
        self._uow = unit_of_work
        self._clock = clock
        self._processing: ProcessingPort = processing or ProcessingNotAvailable()

    # ------------------------------------------------------------------ helpers
    @contextmanager
    def _unit(self) -> Iterator[UnitTransaction]:
        try:
            with self._uow.unit(self._clock) as tx:
                yield tx
        except CapacityError as exc:
            raise AppError(409, exc.code, exc.message) from None

    @staticmethod
    def linked_responsible(tx: UnitTransaction, i: Intimation) -> str | None:
        if not i.deadline_id:
            return None
        d = tx.deadlines.get(i.deadline_id)
        return d.responsible_id if d else None

    def _readable(self, tx: UnitTransaction, actor_id: str, intimation_id: str) -> tuple[Intimation, Membership | None]:
        m = tx.org.membership_of_user(actor_id)
        i = tx.intimations.get(intimation_id)
        if i is None or not policy.can_read(actor_id, m, i, self.linked_responsible(tx, i)):
            ops.raise_denial(NOT_FOUND)
        assert i is not None
        return i, m

    @staticmethod
    def _visible_deadline(tx: UnitTransaction, actor_id: str, m: Membership | None, i: Intimation) -> str | None:
        if not i.deadline_id:
            return None
        return ops.visible_ref(tx, actor_id, m, "deadline", i.deadline_id)

    def _result(self, tx: UnitTransaction, actor_id: str, m: Membership | None, i: Intimation) -> IntimationResult:
        return IntimationResult(i, self._visible_deadline(tx, actor_id, m, i))

    @staticmethod
    def _version(i: Intimation, version: int) -> None:
        if i.version != version:
            raise AppError(409, "version_conflict", f"A intimação foi alterada (versão atual {i.version}).",
                           headers={"X-Current-Version": str(i.version)})

    @staticmethod
    def _event(tx: UnitTransaction, i: Intimation, actor_id: str, action: str, **details: Any) -> IntimationEvent:
        event = IntimationEvent(id=uuid.uuid4().hex, intimation_id=i.id, actor_id=actor_id, action=action,
                                at=tx.now, details=details)
        tx.intimations.add_event(event)
        return event

    @staticmethod
    def _check_suggested(tx: UnitTransaction, actor_id: str, m: Membership | None, scope: Scope, user_id: str) -> None:
        """Autorização (403) — a validade do alvo (422) é verificada separadamente."""
        if (d := dl_policy.check_assignment(actor_id, m, scope.kind, user_id)):
            ops.raise_denial(d)

    def _notify_suggested(self, tx: UnitTransaction, i: Intimation, actor_id: str, event: IntimationEvent) -> None:
        if i.suggested_responsible_id:
            ops.notify(tx, recipient_id=i.suggested_responsible_id, actor_id=actor_id, kind="intimation_assigned",
                       resource_type="intimation", resource_id=i.id, scope=i.scope, event_id=event.id)

    # ------------------------------------------------------------------ registrar
    def register(
        self, actor_id: str, kind: ScopeKind, meta: dict[str, Any], suggested_responsible_id: str | None
    ) -> IntimationResult:
        processing_requested = False
        with self._unit() as tx:
            m = tx.org.membership_of_user(actor_id)
            if (d := dl_policy.check_create(actor_id, m, kind)):
                ops.raise_denial(d)
            scope = Scope.personal(actor_id) if kind == "personal" else Scope.office(m.office_id)  # type: ignore[union-attr]
            if suggested_responsible_id is not None:
                self._check_suggested(tx, actor_id, m, scope, suggested_responsible_id)
                ops.active_responsible(tx, scope, suggested_responsible_id)
            available = self._processing.available
            i = Intimation(
                id=uuid.uuid4().hex, scope=scope,
                file=FileMeta(meta["file_name"], meta["size_bytes"], meta["content_type"]),
                received_at=meta["received_at"],
                status="processing" if available else "awaiting_review",
                processing=Processing(status="pending" if available else "not_available"),
                draft=Draft(), created_by=actor_id, created_at=tx.now, updated_at=tx.now,
                suggested_responsible_id=suggested_responsible_id,
            )
            tx.intimations.put(i)
            event = self._event(tx, i, actor_id, "registered", fileStorage="not_stored",
                                suggestedResponsibleId=suggested_responsible_id)
            self._notify_suggested(tx, i, actor_id, event)
            processing_requested = available
            result = self._result(tx, actor_id, m, i)
        if processing_requested:
            self._processing.request(i.id)    # só depois do commit
        logger.info("intimation_registered intimation_id=%s scope=%s", i.id, scope.kind)
        return result

    # ------------------------------------------------------------------ leitura
    def get(self, actor_id: str, intimation_id: str) -> IntimationResult:
        with self._unit() as tx:
            i, m = self._readable(tx, actor_id, intimation_id)
            return self._result(tx, actor_id, m, i)

    def list_intimations(
        self, actor_id: str, kind: ScopeKind, status: str | None, q: str | None, page: int, per_page: int
    ) -> tuple[list[IntimationResult], int]:
        with self._unit() as tx:
            m = tx.org.membership_of_user(actor_id)
            if kind == "personal":
                scope = Scope.personal(actor_id)
            else:
                if m is None:
                    ops.raise_denial(NOT_FOUND)
                assert m is not None
                if not m.has("deadline.read"):
                    ops.raise_denial(dl_policy.FORBIDDEN)
                scope = Scope.office(m.office_id)
            items = [
                i for i in tx.intimations.in_scope(scope)
                if policy.can_read(actor_id, m, i, self.linked_responsible(tx, i))   # autoriza ANTES
            ]
            if status:
                items = [i for i in items if i.status == status]
            else:
                items = [i for i in items if i.status != "discarded"]                # oculto por padrão
            if q:
                needle = q.casefold()
                items = [i for i in items if needle in f"{i.file.name} {i.draft.title or ''} "
                         f"{i.draft.case_number or ''}".casefold()]
            items.sort(key=lambda i: i.id)
            items.sort(key=lambda i: i.created_at, reverse=True)
            total = len(items)
            start = (page - 1) * per_page
            return [self._result(tx, actor_id, m, i) for i in items[start:start + per_page]], total

    def history(self, actor_id: str, intimation_id: str, page: int, per_page: int) -> tuple[list[IntimationEvent], int]:
        with self._unit() as tx:
            i, m = self._readable(tx, actor_id, intimation_id)
            events = list(tx.intimations.events(i.id))
            start = (page - 1) * per_page
            # Projeção autorizada DENTRO da unidade; o histórico armazenado não é alterado.
            page_items = [replace(e, details=ops.project_details(tx, actor_id, m, e.details))
                          for e in events[start:start + per_page]]
        return page_items, len(events)

    # ------------------------------------------------------------------ rascunho
    def update_draft(
        self, actor_id: str, intimation_id: str, version: int, draft: dict[str, Any],
        suggested: str | None, suggested_provided: bool,
    ) -> IntimationResult:
        with self._unit() as tx:
            i, m = self._readable(tx, actor_id, intimation_id)
            if (den := policy.check_write(actor_id, m, i, self.linked_responsible(tx, i))):
                ops.raise_denial(den)
            change_suggested = suggested_provided and suggested != i.suggested_responsible_id
            if change_suggested and suggested is not None:
                self._check_suggested(tx, actor_id, m, i.scope, suggested)
            self._version(i, version)
            if i.status != "awaiting_review":
                raise AppError(409, "invalid_state", "A intimação não está aguardando revisão.")
            if change_suggested and suggested is not None:
                ops.active_responsible(tx, i.scope, suggested)
            if change_suggested and suggested is None and i.scope.kind == "office" \
                    and not ops.is_active_member(tx, i.scope.office_id, i.created_by):
                raise AppError(
                    409, "operational_responsible_required",
                    "O autor não pertence mais ao escritório: a intimação precisa de um responsável sugerido.",
                )
            effective = {k: v for k, v in draft.items() if getattr(i.draft, k) != v}
            if not effective and not change_suggested:
                return self._result(tx, actor_id, m, i)
            new_draft = replace(i.draft, **effective)
            if new_draft.start_date and new_draft.due_date and new_draft.due_date < new_draft.start_date:
                raise AppError(422, "invalid_dates", "O vencimento não pode ser anterior ao início.")
            updated = replace(
                i, draft=new_draft, version=i.version + 1, updated_at=tx.now,
                suggested_responsible_id=suggested if change_suggested else i.suggested_responsible_id,
            )
            tx.intimations.put(updated)
            if effective:
                changes = {
                    _CAMEL.get(k, k): {"from": ops.to_json(getattr(i.draft, k)), "to": ops.to_json(v)}
                    for k, v in effective.items()
                }
                self._event(tx, updated, actor_id, "draft_updated", changes=changes)
            if change_suggested:
                event = self._event(tx, updated, actor_id, "responsible_suggested",
                                    fromResponsibleId=i.suggested_responsible_id, toResponsibleId=suggested)
                self._notify_suggested(tx, updated, actor_id, event)
            return self._result(tx, actor_id, m, updated)

    # ------------------------------------------------------------------ confirmação
    def confirm(self, actor_id: str, intimation_id: str, version: int, data: dict[str, Any]) -> ConfirmResult:
        with self._unit() as tx:
            i, m = self._readable(tx, actor_id, intimation_id)                       # 404 se não lê
            if (den := policy.check_write(actor_id, m, i, self.linked_responsible(tx, i))):
                ops.raise_denial(den)                                               # 403
            if i.status == "reviewed":
                # Repetição: sem novo efeito, mesmo com versão antiga — mas só revela o prazo a quem o lê.
                linked = self._visible_deadline(tx, actor_id, m, i)
                if linked is None:
                    raise AppError(409, "already_reviewed", "A intimação já foi revisada.")
                return ConfirmResult(self._result(tx, actor_id, m, i), tx.deadlines.get(linked), False)  # type: ignore[arg-type]
            if i.status == "discarded":
                raise AppError(409, "invalid_state", "Intimação descartada não pode ser confirmada.")
            self._version(i, version)
            if i.status != "awaiting_review":
                raise AppError(409, "invalid_state", "A intimação não está aguardando revisão.")
            # Regras de criação da Etapa 4, na MESMA unidade (sem transação aninhada).
            deadline = ops.create_deadline(tx, actor_id, i.scope.kind, {**data, "reviewed": True},
                                           source={"intimationId": i.id})
            tx.checkpoint("confirm:deadline")
            reviewed = replace(i, status="reviewed", deadline_id=deadline.id, closed_at=tx.now,
                               version=i.version + 1, updated_at=tx.now)
            tx.intimations.put(reviewed)
            tx.checkpoint("confirm:intimation")
            self._event(tx, reviewed, actor_id, "confirmed", deadlineId=deadline.id)
            tx.checkpoint("confirm:event")
            result = ConfirmResult(self._result(tx, actor_id, m, reviewed), deadline, True)
        logger.info("intimation_confirmed intimation_id=%s deadline_id=%s", intimation_id, deadline.id)
        return result

    # ------------------------------------------------------------------ descarte / nova tentativa
    def discard(self, actor_id: str, intimation_id: str, version: int) -> IntimationResult:
        with self._unit() as tx:
            i, m = self._readable(tx, actor_id, intimation_id)
            if (den := policy.check_write(actor_id, m, i, self.linked_responsible(tx, i), owner_or_all=True)):
                ops.raise_denial(den)
            self._version(i, version)
            if not i.pending:
                raise AppError(409, "invalid_state", "Somente intimações pendentes podem ser descartadas.")
            updated = replace(i, status="discarded", closed_at=tx.now, version=i.version + 1, updated_at=tx.now)
            tx.intimations.put(updated)
            self._event(tx, updated, actor_id, "discarded", fromStatus=i.status)
            return self._result(tx, actor_id, m, updated)

    def retry(self, actor_id: str, intimation_id: str, version: int) -> IntimationResult:
        with self._unit() as tx:
            i, m = self._readable(tx, actor_id, intimation_id)
            if (den := policy.check_write(actor_id, m, i, self.linked_responsible(tx, i), owner_or_all=True)):
                ops.raise_denial(den)
            self._version(i, version)
            if i.status != "failed":
                raise AppError(409, "invalid_state", "Somente intimações com falha podem ser reprocessadas.")
            if not self._processing.available:
                raise AppError(409, "processing_unavailable", "Processamento de intimações indisponível nesta etapa.")
            updated = replace(i, status="processing", version=i.version + 1, updated_at=tx.now,
                              processing=replace(i.processing, status="pending", failure_code=None))
            tx.intimations.put(updated)
            self._event(tx, updated, actor_id, "retry_requested")
            result = self._result(tx, actor_id, m, updated)
        self._processing.request(intimation_id)       # só depois do commit
        return result

    # ------------------------------------------------------------------ interno (sem rota HTTP)
    def apply_processing_result(
        self, intimation_id: str, outcome: str, *, fields: dict[str, Any] | None = None,
        failure_code: str | None = None,
    ) -> Intimation:
        """Resultado do processamento futuro. Sugestões NUNCA dispensam a revisão humana."""
        with self._unit() as tx:
            i = tx.intimations.get(intimation_id)
            if i is None or i.status != "processing":
                raise AppError(409, "invalid_state", "Intimação não está em processamento.")
            attempts = i.processing.attempts + 1
            if outcome == "completed":
                updated = replace(i, status="awaiting_review", version=i.version + 1, updated_at=tx.now,
                                  processing=Processing("completed", attempts),
                                  suggestion=Suggestion("processing", dict(fields or {})))
            else:
                updated = replace(i, status="failed", version=i.version + 1, updated_at=tx.now,
                                  processing=Processing("failed", attempts, failure_code or "processing_failed"))
            tx.intimations.put(updated)
            self._event(tx, updated, SYSTEM_ACTOR, f"processing_{outcome}")
            return updated
