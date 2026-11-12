"""Casos de uso de prazos, comentários, histórico, calendário e transferência (Etapa 4).

Toda operação roda na unidade de trabalho composta (escritórios → prazos), com o
instante lido DEPOIS dos locks. O vínculo do ator e o do responsável são lidos dentro da
transação; a política é aplicada antes de qualquer escrita; histórico e alteração são
publicados juntos (ou descartados juntos).

Ordem das verificações em operações sobre prazo existente: leitura (404) →
permissões, incluindo regras de delegação (403) → versão (409 `version_conflict`,
só depois da autorização) → regras de negócio (409/422).
"""
from __future__ import annotations

import uuid
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass, replace
from datetime import date, datetime, time
from typing import Any
from zoneinfo import ZoneInfo

from app.core.clock import Clock
from app.core.errors import AppError
from app.core.logging import get_logger
from app.domain.deadlines import TRANSITIONS, Comment, Deadline, HistoryEvent, Scope, ScopeKind
from app.domain.errors import CapacityError
from app.domain.intimations import IntimationEvent
from app.domain.org import Membership
from app.policies import deadlines as policy
from app.policies.org import NOT_FOUND, Denial
from app.repositories.deadlines import UnitTransaction
from app.repositories.queries import DeadlineSearch, MonthSearch, Viewer
from app.repositories.unit import UnitOfWork
from app.services import deadline_ops as ops

logger = get_logger("prazoai.deadlines")

EDITABLE = (
    "title", "case_number", "court", "practice_area", "responsible_id", "priority",
    "start_date", "due_date", "counting_mode", "duration", "agenda_time", "reviewed",
)
_CAMEL = {
    "case_number": "caseNumber", "practice_area": "practiceArea", "responsible_id": "responsibleId",
    "start_date": "startDate", "due_date": "dueDate", "counting_mode": "countingMode", "agenda_time": "agendaTime",
}
SHARING_NOTICE = (
    "Prazo transferido ao escritório: comentários e histórico passam a ser visíveis a quem tiver "
    "acesso ao prazo no escritório. Intimações e arquivos não existem no backend nesta etapa."
)


def _raise(denial: Denial) -> None:
    raise AppError(denial.status, denial.code, denial.message)


def _json(value: Any) -> Any:
    if isinstance(value, (date, datetime)):
        return value.isoformat()
    if isinstance(value, time):
        return value.strftime("%H:%M")
    return value


@dataclass(frozen=True)
class Page:
    items: list[Deadline]
    total: int
    page: int
    per_page: int

    @property
    def page_count(self) -> int:
        return max(1, -(-self.total // self.per_page))


@dataclass(frozen=True)
class ListQuery:
    scope: ScopeKind
    q: str | None = None
    status: str | None = None
    urgency: str | None = None
    area: str | None = None
    responsible_id: str | None = None
    due_from: date | None = None
    due_to: date | None = None
    sort: str = "dueDate"
    direction: str = "asc"
    page: int = 1
    per_page: int = 20


class DeadlineService:
    def __init__(self, *, unit_of_work: UnitOfWork, clock: Clock, timezone: str, soon_days: int) -> None:
        self._uow = unit_of_work
        self._clock = clock
        self._tz = ZoneInfo(timezone)
        self._soon = soon_days

    @property
    def timezone_name(self) -> str:
        return str(self._tz)

    # ------------------------------------------------------------------ helpers
    @contextmanager
    def _unit(self) -> Iterator[UnitTransaction]:
        try:
            with self._uow.unit(self._clock) as tx:
                yield tx
        except CapacityError as exc:
            raise AppError(409, exc.code, exc.message) from None

    @contextmanager
    def _read(self) -> Iterator[UnitTransaction]:
        """Leitura consistente (PostgreSQL: REPEATABLE READ READ ONLY, um snapshot)."""
        with self._uow.read(self._clock) as tx:
            yield tx

    def today(self, now: datetime | None = None) -> date:
        """Data civil de referência (fuso DEADLINES_TIMEZONE) para urgência."""
        return (now or self._clock.now()).astimezone(self._tz).date()

    def urgency(self, d: Deadline, today: date) -> dict[str, Any] | None:
        """Classificação VISUAL (não jurídica) para prazos em aberto."""
        if d.status != "open":
            return None
        days = (d.due_date - today).days
        if days < 0:
            level = "overdue"
        elif days == 0:
            level = "today"
        elif days <= self._soon:
            level = "soon"
        else:
            level = "upcoming"
        return {"level": level, "days": days}

    @staticmethod
    def _membership(tx: UnitTransaction, user_id: str) -> Membership | None:
        return tx.org.membership_of_user(user_id)

    @staticmethod
    def _readable(tx: UnitTransaction, actor_id: str, deadline_id: str) -> tuple[Deadline, Membership | None]:
        m = tx.org.membership_of_user(actor_id)
        d = tx.deadlines.get(deadline_id)
        if d is None or not policy.can_read(actor_id, m, d):
            _raise(NOT_FOUND)
        assert d is not None
        return d, m

    @staticmethod
    def _check_version(d: Deadline, version: int) -> None:
        if d.version != version:
            raise AppError(409, "version_conflict", f"O prazo foi alterado (versão atual {d.version}).",
                           headers={"X-Current-Version": str(d.version)})

    @staticmethod
    def _active_responsible(tx: UnitTransaction, scope: Scope, user_id: str) -> None:
        ops.active_responsible(tx, scope, user_id)

    @staticmethod
    def _event(tx: UnitTransaction, d: Deadline, actor_id: str, action: str, **details: Any) -> None:
        ops.record_event(tx, d, actor_id, action, **details)

    @staticmethod
    def _scope_for(tx: UnitTransaction, actor_id: str, kind: ScopeKind) -> tuple[Scope, Membership | None]:
        m = tx.org.membership_of_user(actor_id)
        if kind == "personal":
            return Scope.personal(actor_id), m
        if m is None:
            _raise(NOT_FOUND)
        assert m is not None
        if not m.has("deadline.read"):
            _raise(policy.FORBIDDEN)
        return Scope.office(m.office_id), m

    # ------------------------------------------------------------------- criar
    def create(self, actor_id: str, kind: ScopeKind, data: dict[str, Any]) -> Deadline:
        with self._unit() as tx:
            deadline = ops.create_deadline(tx, actor_id, kind, data)
        logger.info("deadline_created deadline_id=%s scope=%s", deadline.id, deadline.scope.kind)
        return deadline

    # ------------------------------------------------------------------ leitura
    def get(self, actor_id: str, deadline_id: str) -> Deadline:
        with self._read() as tx:
            return self._readable(tx, actor_id, deadline_id)[0]

    def list_deadlines(self, actor_id: str, query: ListQuery) -> tuple[Page, date]:
        with self._read() as tx:
            scope, m = self._scope_for(tx, actor_id, query.scope)
            today = self.today(tx.now)
            # Autorização, filtros, ordenação e paginação no repositório (SQL no PostgreSQL), no mesmo snapshot.
            items, total = tx.queries.deadlines(DeadlineSearch(
                scope=scope, viewer=Viewer(actor_id, m), today=today, soon_days=self._soon, q=query.q,
                status=query.status, urgency=query.urgency, area=query.area, responsible_id=query.responsible_id,
                due_from=query.due_from, due_to=query.due_to, sort=query.sort, direction=query.direction,
                page=query.page, per_page=query.per_page,
            ))
        return Page(items, total, query.page, query.per_page), today

    def calendar(
        self, actor_id: str, kind: ScopeKind, year: int, month: int, status: str | None, page: int, per_page: int
    ) -> tuple[Page, dict[str, int], date]:
        with self._read() as tx:
            scope, m = self._scope_for(tx, actor_id, kind)
            today = self.today(tx.now)
            items, total, counts = tx.queries.month(MonthSearch(
                scope=scope, viewer=Viewer(actor_id, m), year=year, month=month, status=status, page=page,
                per_page=per_page,
            ))
        return Page(items, total, page, per_page), counts, today

    # ------------------------------------------------------------------- editar
    def update(self, actor_id: str, deadline_id: str, version: int, changes: dict[str, Any]) -> Deadline:
        with self._unit() as tx:
            d, m = self._readable(tx, actor_id, deadline_id)
            if (den := policy.check_write(actor_id, m, d, policy.OP_PERMISSION["edit"])):
                _raise(den)
            new_resp = changes.get("responsible_id")
            if new_resp is not None and new_resp != d.responsible_id:
                if (den := policy.check_assignment(actor_id, m, d.scope.kind, new_resp)):
                    _raise(den)
            self._check_version(d, version)
            effective = {k: v for k, v in changes.items() if getattr(d, k) != v}
            if not effective:
                return d                          # sem mudança efetiva: sem versão nem histórico
            updated = replace(d, **effective, version=d.version + 1, updated_at=tx.now)
            if updated.due_date < updated.start_date:
                raise AppError(422, "invalid_dates", "O vencimento não pode ser anterior ao início.")
            if "responsible_id" in effective:
                self._active_responsible(tx, d.scope, updated.responsible_id)
            tx.deadlines.put(updated)
            fields_changed = {
                _CAMEL.get(k, k): {"from": _json(getattr(d, k)), "to": _json(v)}
                for k, v in effective.items() if k != "responsible_id"
            }
            if fields_changed:
                self._event(tx, updated, actor_id, "updated", changes=fields_changed)
            if "responsible_id" in effective:
                ops.reassign_event(tx, updated, actor_id, d.responsible_id, updated.responsible_id, "edit")
        return updated

    # ------------------------------------------------------------------- status
    def change_status(
        self, actor_id: str, deadline_id: str, version: int, status: str, responsible_id: str | None
    ) -> Deadline:
        with self._unit() as tx:
            d, m = self._readable(tx, actor_id, deadline_id)
            reassigning = responsible_id is not None and responsible_id != d.responsible_id
            if responsible_id is not None and status != "open":
                raise AppError(422, "validation_error", "responsibleId só pode acompanhar a reabertura.")
            perms = ["deadline.complete"] + (["deadline.edit"] if reassigning else [])
            if (den := policy.check_write(actor_id, m, d, *perms)):
                _raise(den)
            if reassigning and (den := policy.check_assignment(actor_id, m, d.scope.kind, responsible_id or "")):
                _raise(den)
            self._check_version(d, version)
            if status == d.status:
                raise AppError(409, "status_unchanged", "O prazo já está neste status.")
            if status not in TRANSITIONS[d.status]:
                raise AppError(409, "invalid_transition", "Transição de status não permitida; reabra o prazo antes.")
            new_resp = d.responsible_id
            if status == "open":
                if reassigning:
                    self._active_responsible(tx, d.scope, responsible_id or "")
                    new_resp = responsible_id or d.responsible_id
                elif d.scope.kind == "office":
                    current = tx.org.membership_of_user(d.responsible_id)
                    if current is None or current.office_id != d.scope.office_id:
                        raise AppError(409, "responsible_inactive",
                                       "O responsável não pertence mais ao escritório; informe um novo responsável.")
            updated = replace(d, status=status, responsible_id=new_resp,  # type: ignore[arg-type]
                              version=d.version + 1, updated_at=tx.now)
            tx.deadlines.put(updated)
            self._event(tx, updated, actor_id, "status_changed", **{"from": d.status, "to": status})
            if new_resp != d.responsible_id:
                ops.reassign_event(tx, updated, actor_id, d.responsible_id, new_resp, "reopen")
        return updated

    # ------------------------------------------------------------ transferência
    def transfer(
        self, actor_id: str, deadline_id: str, version: int, office_id: str, share_linked_intimation: bool = False
    ) -> Deadline:
        with self._unit() as tx:
            # Duas âncoras (escritório de destino e escopo pessoal do ator), na ordem aprovada;
            # tudo abaixo é relido e revalidado depois delas.
            tx.lock_anchors(office_ids=(office_id,), user_ids=(actor_id,))
            m = self._membership(tx, actor_id)
            d = tx.deadlines.get(deadline_id)
            if d is None:
                _raise(NOT_FOUND)
            assert d is not None
            if (den := policy.check_transfer(actor_id, m, d, office_id)):
                _raise(den)
            self._check_version(d, version)
            linked = tx.intimations.by_deadline(d.id)
            if linked is not None and share_linked_intimation is not True:
                raise AppError(409, "linked_intimation_requires_consent",
                               "O prazo tem intimação vinculada: confirme também o compartilhamento dela.")
            scope = Scope.office(office_id)
            self._active_responsible(tx, scope, d.responsible_id)   # dono é membro ativo do destino
            moved = replace(d, scope=scope, version=d.version + 1, updated_at=tx.now)
            tx.deadlines.put(moved)
            extra = {"linkedIntimationId": linked.id} if linked else {}
            self._event(tx, moved, actor_id, "transferred", fromScope="personal", toOfficeId=office_id, **extra)
            tx.checkpoint("transfer:deadline")
            if linked is not None:
                tx.intimations.put(replace(linked, scope=scope, version=linked.version + 1, updated_at=tx.now))
                tx.intimations.add_event(IntimationEvent(
                    id=uuid.uuid4().hex, intimation_id=linked.id, actor_id=actor_id, action="transferred",
                    at=tx.now, details={"fromScope": "personal", "toOfficeId": office_id, "deadlineId": d.id},
                ))
                tx.checkpoint("transfer:intimation")
        logger.info("deadline_transferred deadline_id=%s office_id=%s", deadline_id, office_id)
        return moved

    # -------------------------------------------------------------- comentários
    def add_comment(self, actor_id: str, deadline_id: str, text: str) -> Comment:
        with self._unit() as tx:
            d, m = self._readable(tx, actor_id, deadline_id)
            if (den := policy.check_write(actor_id, m, d, policy.OP_PERMISSION["comment"])):
                _raise(den)
            comment = Comment(id=uuid.uuid4().hex, deadline_id=d.id, author_id=actor_id, text=text, created_at=tx.now)
            tx.deadlines.add_comment(comment)
        return comment

    def comments(self, actor_id: str, deadline_id: str, page: int, per_page: int) -> tuple[list[Comment], int]:
        with self._read() as tx:
            d, _ = self._readable(tx, actor_id, deadline_id)
            return tx.queries.comments(d.id, page, per_page)

    def history(self, actor_id: str, deadline_id: str, page: int, per_page: int) -> tuple[list[HistoryEvent], int]:
        with self._read() as tx:
            d, m = self._readable(tx, actor_id, deadline_id)
            items, total = tx.queries.history(d.id, page, per_page)
            # Mesma projeção autorizada das intimações (referências a recursos protegidos), no mesmo snapshot.
            page_items = [replace(e, details=ops.project_details(tx, actor_id, m, e.details)) for e in items]
        return page_items, total
