"""Unidade de trabalho do domínio no PostgreSQL.

Uma operação de negócio = UMA conexão e UMA transação (escritórios, prazos, intimações e
notificações juntos); qualquer exceção → ROLLBACK integral.

Bloqueios (doc 15, §4.2): âncoras de escopo (linha de `offices` e, para escopos pessoais, de
`users`, com `FOR NO KEY UPDATE`) → vínculos → prazos → intimações → caixas de notificação. As
âncoras são travadas no PONTO DE ACESSO: toda leitura de um recurso de escopo, numa unidade de
escrita, faz uma identificação PRELIMINAR sem bloqueio, trava a âncora e RELÊ o recurso (o
escopo é revalidado). Operações com mais de um escopo travam as âncoras antes (`lock_anchors`,
escritórios → usuários, IDs ordenados). `tx.now` vem do relógio injetável e é capturado no
primeiro acesso, depois dos bloqueios já obtidos.

Preparação (antes do COMMIT): limites de capacidade, política da caixa de notificações (sob
bloqueio consultivo por destinatário, em ordem estável) e verificação do responsável operacional
das intimações pendentes. As FKs diferidas (responsável/sugerido ativo, vínculo no mesmo ambiente)
são verificadas pelo próprio PostgreSQL no COMMIT; violação ali é defeito → `ConsistencyError`.
SQLSTATE 40P01/55P03 → `ConcurrentUpdateError` (409), sem repetição. Nenhum expurgo acontece
dentro das transações de negócio (retenção global: P5).
"""
from __future__ import annotations

from collections.abc import Callable, Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime

from sqlalchemy import Connection, Engine, and_, delete, exists, false, func, not_, or_, select, text
from sqlalchemy.exc import DBAPIError, IntegrityError

from app.core.clock import Clock
from app.core.errors import ConcurrentUpdateError
from app.db.tables import (
    deadline_comments,
    deadline_history,
    deadlines,
    intimation_events,
    intimations,
    memberships,
    notifications,
    offices,
    users,
)
from app.domain.deadlines import Scope
from app.domain.errors import CapacityError, ConsistencyError
from app.repositories.sql._base import CONCURRENCY_SQLSTATES, sqlstate
from app.repositories.sql.domain.mapping import U

DEFERRED_CONSTRAINTS = frozenset({
    "fk_deadlines_active_responsible", "fk_intimations_suggested_active", "fk_intimations_deadline_same_scope",
})
PENDING = ("processing", "awaiting_review", "failed")


class LateAnchorError(RuntimeError):
    """Defeito de programação: âncora adquirida depois de o relógio da operação ser capturado."""


@dataclass(frozen=True)
class DomainLimits:
    deadlines_per_scope: int
    comments_per_deadline: int
    history_per_deadline: int
    intimations_per_scope: int
    events_per_intimation: int
    notifications_per_recipient: int


class SqlContext:
    """Estado compartilhado pelas transações de módulo dentro de UMA unidade."""

    def __init__(self, conn: Connection, clock: Clock, *, read_only: bool, allow_membership_delete: bool,
                 checkpoint: Callable[[str], None] | None = None) -> None:
        self.conn = conn
        self.checkpoint = checkpoint or (lambda _name: None)
        self.clock = clock
        self.read_only = read_only
        self.allow_membership_delete = allow_membership_delete
        self._now: datetime | None = None
        self._offices: set = set()
        self._users: set = set()
        self.touched_deadline_scopes: set[str] = set()
        self.touched_deadlines: set = set()
        self.touched_intimation_scopes: set[str] = set()
        self.touched_intimations: set = set()
        self.removed_member_offices: set = set()
        self.recipients: set = set()
        self.scopes: dict[str, Scope] = {}

    @property
    def now(self) -> datetime:
        """UM instante por operação, capturado no primeiro uso. Toda âncora precisa ser adquirida
        ANTES disso (ver `_guard_late_anchor`), para que o instante seja realmente pós-lock."""
        if self._now is None:
            self._now = self.clock.now()          # DEPOIS dos bloqueios já obtidos
        return self._now

    @property
    def now_captured(self) -> bool:
        return self._now is not None

    @property
    def anchored_offices(self) -> frozenset:
        return frozenset(self._offices)

    # ------------------------------------------------------------ âncoras
    def _guard_late_anchor(self, what: str) -> None:
        if self._now is not None:
            raise LateAnchorError(
                f"âncora {what} adquirida depois de capturar o relógio da operação: trave as âncoras antes de "
                "usar tx.now (o instante deixaria de ser pós-lock)")

    def anchor_office(self, office_id) -> None:
        if self.read_only or office_id is None or office_id in self._offices:
            return
        self._guard_late_anchor("de escritório")
        self.conn.execute(select(offices.c.id).where(offices.c.id == office_id).with_for_update(key_share=True))
        self._offices.add(office_id)

    def adopt_new_office(self, office_id) -> None:
        """Escritório recém-inserido nesta transação: invisível aos demais até o COMMIT; vira âncora
        desta unidade sem bloqueio (e sem violar a regra do relógio)."""
        self._offices.add(office_id)

    def anchor_user(self, user_id) -> None:
        if self.read_only or user_id is None or user_id in self._users:
            return
        self._guard_late_anchor("pessoal")
        self.conn.execute(select(users.c.id).where(users.c.id == user_id).with_for_update(key_share=True))
        self._users.add(user_id)

    def anchor_scope(self, scope: Scope) -> None:
        if scope.kind == "office":
            self.anchor_office(U(scope.office_id))
        else:
            self.anchor_user(U(scope.owner_id))

    def anchor_row_scope(self, row) -> None:
        if row.scope_kind == "office":
            self.anchor_office(row.office_id)
        else:
            self.anchor_user(row.owner_id)

    def lock_anchors(self, office_ids: tuple[str, ...], user_ids: tuple[str, ...]) -> None:
        for oid in sorted(filter(None, (U(o) for o in office_ids)), key=str):
            self.anchor_office(oid)
        for uid in sorted(filter(None, (U(u) for u in user_ids)), key=str):
            self.anchor_user(uid)

    def require_write(self) -> None:
        if self.read_only:
            raise RuntimeError("escrita em unidade de leitura")


class SqlUnitTransaction:
    def __init__(self, ctx: SqlContext, checkpoint: Callable[[str], None]) -> None:
        from app.repositories.sql.domain.deadlines import SqlDeadlineTransaction
        from app.repositories.sql.domain.intimations import SqlIntimationTransaction
        from app.repositories.sql.domain.notifications import SqlNotificationTransaction
        from app.repositories.sql.domain.org import SqlOrgTransaction

        self._ctx = ctx
        self._checkpoint = checkpoint
        self.org = SqlOrgTransaction(ctx)
        self.deadlines = SqlDeadlineTransaction(ctx)
        self.intimations = SqlIntimationTransaction(ctx)
        self.notifications = SqlNotificationTransaction(ctx)

    @property
    def now(self) -> datetime:
        return self._ctx.now

    def checkpoint(self, name: str) -> None:
        self._checkpoint(name)

    def lock_anchors(self, *, office_ids: tuple[str, ...] = (), user_ids: tuple[str, ...] = ()) -> None:
        self._ctx.lock_anchors(office_ids, user_ids)

    @property
    def queries(self):
        from app.repositories.sql.domain.queries import SqlQueries

        return SqlQueries(self._ctx)


class SqlUnitOfWork:
    def __init__(self, engine: Engine, limits: DomainLimits, *,
                 checkpoint: Callable[[str], None] | None = None, retention=None) -> None:
        self.engine = engine
        self.limits = limits
        self.retention = retention                            # RetentionPolicy (P5)
        self.fault: Callable[[str], None] | None = None      # injeção de falhas (testes), como na memória
        self._hook = checkpoint                               # gates de concorrência (testes)

    def _checkpoint(self, name: str) -> None:
        if self._hook is not None:
            self._hook(name)
        if self.fault is not None:
            self.fault(name)

    @contextmanager
    def _connection(self) -> Iterator[Connection]:
        try:
            with self.engine.connect() as conn:            # fecha/devolve a conexão em qualquer saída
                yield conn
        except DBAPIError as exc:
            if sqlstate(exc) in CONCURRENCY_SQLSTATES:
                raise ConcurrentUpdateError() from None
            raise

    @contextmanager
    def unit(self, clock: Clock) -> Iterator[SqlUnitTransaction]:
        with self._write(clock, allow_membership_delete=True, prepare_name="unit:prepare") as tx:
            yield tx

    @contextmanager
    def transaction(self, clock: Clock):
        with self._write(clock, allow_membership_delete=False, prepare_name="org:prepare") as tx:
            yield tx.org

    @contextmanager
    def _write(self, clock: Clock, *, allow_membership_delete: bool, prepare_name: str):
        with self._connection() as conn:
            trans = conn.begin()
            try:
                ctx = SqlContext(conn, clock, read_only=False, allow_membership_delete=allow_membership_delete,
                                 checkpoint=self._checkpoint)
                tx = SqlUnitTransaction(ctx, self._checkpoint)
                yield tx
                self._prepare(ctx)
                self._checkpoint(prepare_name)
                if allow_membership_delete:
                    # Equivalentes dos pontos de PUBLICAÇÃO da memória: no PostgreSQL não há publicação
                    # parcial (tudo é confirmado no COMMIT); uma falha aqui desfaz a transação inteira.
                    for point in ("unit:publish", "unit:publish:1", "unit:publish:2"):
                        self._checkpoint(point)
                self._checkpoint("unit:commit")
                try:
                    trans.commit()
                except IntegrityError as exc:
                    constraint: str | None = getattr(getattr(exc.orig, "diag", None), "constraint_name", None)
                    if constraint in DEFERRED_CONSTRAINTS:
                        raise ConsistencyError(f"invariante violada no COMMIT ({constraint})") from None
                    raise
            except BaseException:
                if trans.is_active:
                    trans.rollback()
                raise

    @contextmanager
    def read(self, clock: Clock) -> Iterator[SqlUnitTransaction]:
        """Leitura consistente: REPEATABLE READ READ ONLY (um único snapshot para tudo)."""
        with self._connection() as conn:
            conn.begin()
            conn.exec_driver_sql("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
            conn.exec_driver_sql("SELECT 1")               # fixa o snapshot; `now` vem depois
            ctx = SqlContext(conn, clock, read_only=True, allow_membership_delete=False, checkpoint=self._checkpoint)
            try:
                yield SqlUnitTransaction(ctx, self._checkpoint)
            finally:
                conn.rollback()

    def purge(self, now: datetime) -> int:
        """Retenção EXPLÍCITA do domínio (P5): mesma rotina da manutenção, com o instante dado,
        em transações próprias (nunca dentro de uma operação de negócio). Devolve o total confirmado."""
        if self.retention is None:
            return 0
        from app.maintenance.purge import DOMAIN_CATEGORIES, MaintenanceLimits, run_maintenance

        class _Fixed:
            def now(self) -> datetime:
                return now

        result = run_maintenance(self.engine, _Fixed(), self.retention, MaintenanceLimits(),
                                 categories=DOMAIN_CATEGORIES, operation="domain_purge")
        return result.total

    # ------------------------------------------------------------ preparação final
    def _prepare(self, ctx: SqlContext) -> None:
        lim, conn = self.limits, ctx.conn
        for key in ctx.touched_deadline_scopes:
            n = conn.execute(select(func.count()).select_from(deadlines).where(
                _scope_clause(deadlines, ctx.scopes[key]))).scalar_one()
            if n > lim.deadlines_per_scope:
                raise CapacityError("deadline_limit_reached", "Limite de prazos do ambiente atingido.")
        for did in ctx.touched_deadlines:
            if conn.execute(select(func.count()).select_from(deadline_comments).where(
                    deadline_comments.c.deadline_id == did)).scalar_one() > lim.comments_per_deadline:
                raise CapacityError("comment_limit_reached", "Limite de comentários do prazo atingido.")
            if conn.execute(select(func.count()).select_from(deadline_history).where(
                    deadline_history.c.deadline_id == did)).scalar_one() > lim.history_per_deadline:
                raise CapacityError("history_limit_reached", "Limite de histórico do prazo atingido.")
        for key in ctx.touched_intimation_scopes:
            n = conn.execute(select(func.count()).select_from(intimations).where(
                _scope_clause(intimations, ctx.scopes[key]))).scalar_one()
            if n > lim.intimations_per_scope:
                raise CapacityError("intimation_limit_reached", "Limite de intimações do ambiente atingido.")
        for iid in ctx.touched_intimations:
            if conn.execute(select(func.count()).select_from(intimation_events).where(
                    intimation_events.c.intimation_id == iid)).scalar_one() > lim.events_per_intimation:
                raise CapacityError("intimation_history_limit_reached", "Limite de histórico da intimação atingido.")
        self._check_operational_responsible(ctx)
        self._enforce_inbox(ctx)

    @staticmethod
    def _check_operational_responsible(ctx: SqlContext) -> None:
        """Pendência do escritório precisa de autor OU sugerido com vínculo ATUAL (disjunção entre
        linhas: não expressável como FK; verificada aqui, dentro da transação)."""
        if not ctx.touched_intimations and not ctx.removed_member_offices:
            return
        i = intimations

        def active(user_col):
            return exists().where(and_(memberships.c.user_id == user_col, memberships.c.office_id == i.c.office_id))

        target = or_(i.c.id.in_(ctx.touched_intimations) if ctx.touched_intimations else false(),
                     i.c.office_id.in_(ctx.removed_member_offices) if ctx.removed_member_offices else false())
        orphan = ctx.conn.execute(select(i.c.id).where(
            i.c.status.in_(PENDING), i.c.scope_kind == "office", target,
            not_(active(i.c.created_by)),
            or_(i.c.suggested_responsible_id.is_(None), not_(active(i.c.suggested_responsible_id))),
        ).limit(1)).first()
        if orphan is not None:
            raise ConsistencyError("intimação pendente sem responsável operacional (autor e sugerido inativos)")

    def _enforce_inbox(self, ctx: SqlContext) -> None:
        """Política da caixa: bloqueio consultivo por destinatário (ordem estável) e remoção do
        excedente — lidas mais antigas primeiro, depois não lidas mais antigas."""
        cap = self.limits.notifications_per_recipient
        for rid in sorted(ctx.recipients, key=str):
            ctx.conn.execute(text("SELECT pg_advisory_xact_lock(hashtextextended('inbox:' || :r, 0))"),
                             {"r": str(rid)})
            total = ctx.conn.execute(select(func.count()).select_from(notifications).where(
                notifications.c.recipient_id == rid)).scalar_one()
            excess = total - cap
            if excess > 0:
                victims = select(notifications.c.id).where(notifications.c.recipient_id == rid).order_by(
                    notifications.c.read_at.is_(None).asc(), notifications.c.created_at.asc(), notifications.c.id.asc(),
                ).limit(excess).scalar_subquery()
                ctx.conn.execute(delete(notifications).where(notifications.c.id.in_(victims)))


def _scope_clause(table, scope: Scope):
    from app.repositories.sql.domain.mapping import scope_filter

    return scope_filter(table, scope)
