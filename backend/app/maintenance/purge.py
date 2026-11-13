"""Expurgo global de retenção no PostgreSQL (P5).

Regras (as MESMAS da implementação em memória; fronteira inclusiva `agora − referência ≥ retenção`):
- sessões: expiradas (`expires_at ≤ agora`), com os hashes de refresh usados (filhos antes);
- tokens de recuperação: usados, invalidados ou expirados;
- convites: encerrados há ≥ retenção (referência `closed_at`) ou pendentes expirados há ≥ retenção
  (referência `expires_at`);
- solicitações: decididas há ≥ retenção (referência `decided_at`);
- intimações: SÓ descartadas há ≥ retenção (referência `closed_at`), com eventos e notificações;
- notificações: lidas há ≥ retenção (referência `read_at`).
Contas, escritórios, vínculos, prazos, comentários e históricos de prazos NUNCA são expurgados por idade;
o limite da caixa por destinatário é da P4 e não muda aqui.

Transações e bloqueios (doc 15, §§4.2 e 5.4):
- cada lote é UMA transação curta, própria (nunca dentro de uma operação de negócio), com
  `lock_timeout` e `statement_timeout` próprios (`SET LOCAL`);
- seleção em ordem estável (`ORDER BY id`) com `FOR UPDATE SKIP LOCKED` e tamanho limitado;
- relógio capturado DEPOIS dos bloqueios; a exclusão REVALIDA o predicado com esse instante;
- conjuntos pai/filhos: os filhos também são travados com SKIP LOCKED; se algum filho estiver
  bloqueado por outra transação, o conjunto inteiro fica para uma execução futura (o pai NÃO é
  apagado por cascata para contornar o bloqueio); filhos são apagados explicitamente antes do pai;
- qualquer erro (timeout, deadlock, falha) → ROLLBACK do lote atual e FIM da execução; lotes já
  confirmados permanecem e são contabilizados; não há repetição automática nem laço sobre linhas
  bloqueadas (linhas puladas não são reselecionadas na mesma execução).

Justiça entre categorias (correção da auditoria da P5):
- só lotes COM TRABALHO (≥ 1 linha selecionada) consomem o orçamento `max_batches`; uma categoria
  vazia custa uma sondagem barata e sai da execução (no máximo UMA sondagem vazia por categoria e por
  execução → transações por execução ≤ max_batches + nº de categorias);
- rodízio: cada passada dá NO MÁXIMO um lote a cada categoria ainda ativa, então um acúmulo contínuo
  numa categoria não monopoliza o orçamento;
- `start` define a categoria inicial; o resultado informa `next_start`, de onde a PRÓXIMA execução
  deve começar (a categoria interrompida pelo limite, ou a seguinte à que falhou), garantindo que,
  ao longo de execuções sucessivas, todas as categorias sejam atendidas mesmo com orçamento 1.
"""
from __future__ import annotations

import logging
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import datetime, timedelta

from sqlalchemy import Connection, Engine, and_, delete, func, or_, select, text
from sqlalchemy.exc import DBAPIError

from app.core.clock import Clock
from app.db.tables import (
    auth_sessions,
    auth_used_refresh_hashes,
    intimation_events,
    intimations,
    invitations,
    join_requests,
    notifications,
    password_reset_tokens,
)

logger = logging.getLogger("prazoai.maintenance")


@dataclass(frozen=True)
class RetentionPolicy:
    org_closed_retention: timedelta
    intimation_discard_retention: timedelta
    notification_read_retention: timedelta

    @classmethod
    def from_settings(cls, settings) -> RetentionPolicy:
        return cls(
            org_closed_retention=timedelta(seconds=settings.org_closed_retention_seconds),
            intimation_discard_retention=timedelta(seconds=settings.intimations_discard_retention_seconds),
            notification_read_retention=timedelta(seconds=settings.notifications_read_retention_seconds),
        )


@dataclass(frozen=True)
class MaintenanceLimits:
    batch_size: int = 200
    max_batches: int = 50                 # trabalho máximo da EXECUÇÃO (todas as categorias somadas)
    lock_timeout_ms: int = 200
    statement_timeout_ms: int = 5_000

    @classmethod
    def from_settings(cls, settings, *, max_batches: int | None = None) -> MaintenanceLimits:
        return cls(batch_size=settings.maintenance_batch_size,
                   max_batches=max_batches or settings.maintenance_max_batches_per_run,
                   lock_timeout_ms=settings.maintenance_lock_timeout_ms,
                   statement_timeout_ms=settings.maintenance_statement_timeout_ms)


@dataclass
class MaintenanceResult:
    """Resultado VERIFICÁVEL: só contagens efetivamente CONFIRMADAS (lotes com COMMIT)."""

    removed: dict[str, int] = field(default_factory=dict)
    batches: int = 0                      # lotes COM TRABALHO confirmados (consomem o orçamento)
    empty_checks: int = 0                 # sondagens sem linhas (não consomem o orçamento)
    visited: list[str] = field(default_factory=list)       # categorias atendidas nesta execução
    next_start: int = 0                   # índice (em `categories`) onde a próxima execução deve começar
    skipped_locked: int = 0               # conjuntos pulados por bloqueio (ficam para execução futura)
    limit_reached: bool = False           # parou pelo limite de trabalho (pode haver mais pendências)
    interrupted: bool = False             # parou por falha; o lote em curso foi desfeito
    failure: str | None = None            # categoria segura: lock_timeout | deadlock | statement_timeout | ...
    failed_category: str | None = None
    duration_ms: int = 0

    @property
    def total(self) -> int:
        return sum(self.removed.values())

    @property
    def complete(self) -> bool:
        """Todas as categorias esgotadas (dentro do que não estava bloqueado) nesta execução."""
        return not self.limit_reached and not self.interrupted

    def as_dict(self) -> dict:
        return {"removed": dict(self.removed), "total": self.total, "batches": self.batches,
                "emptyChecks": self.empty_checks, "visited": list(self.visited), "complete": self.complete,
                "skippedLocked": self.skipped_locked, "limitReached": self.limit_reached,
                "interrupted": self.interrupted, "failure": self.failure, "failedCategory": self.failed_category,
                "durationMs": self.duration_ms}


class _Stop(Exception):
    pass


def _failure_category(exc: BaseException) -> str:
    state: str = getattr(getattr(exc, "orig", None), "sqlstate", None) or ""
    return {"55P03": "lock_timeout", "40P01": "deadlock", "57014": "statement_timeout"}.get(
        state, "database_error" if isinstance(exc, DBAPIError) else "error")


# ---------------------------------------------------------------- categorias
@dataclass(frozen=True)
class _Simple:
    """Tabela sem filhos: seleção travada → relógio → DELETE com predicado revalidado."""

    name: str
    table: object
    pk: object
    predicate: Callable[[datetime, RetentionPolicy], object]


@dataclass(frozen=True)
class _WithChildren:
    """Pai com filhos (apagados antes, explicitamente). `children`: [(nome, tabela, pk, fk)]."""

    name: str
    table: object
    pk: object
    predicate: Callable[[datetime, RetentionPolicy], object]
    children: tuple


def _p_sessions(now, _p):
    return auth_sessions.c.expires_at <= now


def _p_reset(now, _p):
    t = password_reset_tokens.c
    return or_(t.used_at.is_not(None), t.invalidated_at.is_not(None), t.expires_at <= now)


def _p_invitations(now, p):
    i, cutoff = invitations.c, now - p.org_closed_retention
    return or_(and_(i.status != "pending", i.closed_at <= cutoff),
               and_(i.status == "pending", i.expires_at <= cutoff))       # expirou há ≥ retenção


def _p_requests(now, p):
    r = join_requests.c
    return and_(r.status != "pending", r.decided_at <= now - p.org_closed_retention)


def _p_intimations(now, p):
    i = intimations.c
    return and_(i.status == "discarded", i.closed_at <= now - p.intimation_discard_retention)


def _p_notifications(now, p):
    return notifications.c.read_at <= now - p.notification_read_retention


CATEGORIES: dict[str, object] = {
    "notifications_read": _Simple("notifications_read", notifications, notifications.c.id, _p_notifications),
    "intimations_discarded": _WithChildren(
        "intimations_discarded", intimations, intimations.c.id, _p_intimations,
        (("intimation_notifications", notifications, notifications.c.id, notifications.c.intimation_id),
         ("intimation_events", intimation_events, intimation_events.c.id, intimation_events.c.intimation_id))),
    "invitations": _Simple("invitations", invitations, invitations.c.id, _p_invitations),
    "join_requests": _Simple("join_requests", join_requests, join_requests.c.id, _p_requests),
    "password_reset_tokens": _Simple("password_reset_tokens", password_reset_tokens,
                                     password_reset_tokens.c.token_hash, _p_reset),
    "sessions": _WithChildren(
        "sessions", auth_sessions, auth_sessions.c.id, _p_sessions,
        (("used_refresh_hashes", auth_used_refresh_hashes, auth_used_refresh_hashes.c.refresh_hash,
          auth_used_refresh_hashes.c.session_id),)),
}
DOMAIN_CATEGORIES = ("notifications_read", "intimations_discarded", "invitations", "join_requests")
AUTH_CATEGORIES = ("password_reset_tokens", "sessions")


# ---------------------------------------------------------------- execução
def run_maintenance(
    engine: Engine, clock: Clock, policy: RetentionPolicy, limits: MaintenanceLimits, *,
    categories: tuple[str, ...] = (*DOMAIN_CATEGORIES, *AUTH_CATEGORIES), start: int = 0,
    checkpoint: Callable[[str], None] | None = None, operation: str = "purge",
) -> MaintenanceResult:
    """Rodízio justo entre categorias a partir de `start`; para no limite de trabalho ou na 1ª falha."""
    result = MaintenanceResult(removed={})
    hook = checkpoint or (lambda _name: None)
    started = time.monotonic()
    n = len(categories)
    first = start % n if n else 0
    order = [categories[(first + k) % n] for k in range(n)]
    active = list(order)                              # categorias que ainda podem ter trabalho
    excluded: dict[str, set] = {name: set() for name in order}
    current = first
    try:
        while active:
            for name in list(active):                 # uma passada: no máximo 1 lote por categoria
                current = categories.index(name)
                if result.batches >= limits.max_batches:
                    result.limit_reached = True
                    result.next_start = current       # a próxima execução começa por quem ficou sem vez
                    raise _Stop()
                selected = _run_batch(engine, clock, policy, limits, CATEGORIES[name], excluded[name], result,
                                      hook)
                if name not in result.visited:
                    result.visited.append(name)
                if selected < limits.batch_size:
                    active.remove(name)               # esgotada nesta execução (inclui sondagem vazia)
        result.next_start = (first + 1) % n if n else 0   # completa: a próxima começa na seguinte
    except _Stop:
        if result.interrupted:
            result.next_start = (current + 1) % n     # depois da que falhou: sem laço sobre ela
    finally:
        result.duration_ms = int((time.monotonic() - started) * 1000)
        logger.info("maintenance operation=%s total=%s batches=%s empty_checks=%s skipped_locked=%s "
                    "limit_reached=%s interrupted=%s failure=%s category=%s duration_ms=%s", operation,
                    result.total, result.batches, result.empty_checks, result.skipped_locked, result.limit_reached,
                    result.interrupted, result.failure, result.failed_category, result.duration_ms)
    return result


def _run_batch(engine, clock, policy, limits, cat, excluded, result, hook) -> int:
    """Um lote = uma transação. Devolve quantos PAIS foram selecionados (para saber se há mais)."""
    pending: dict[str, int] = {}
    try:
        with engine.connect() as conn:                # devolvida ao pool em qualquer saída
            with conn.begin():                        # ROLLBACK integral do lote em qualquer exceção
                conn.execute(text(f"SET LOCAL lock_timeout = '{int(limits.lock_timeout_ms)}ms'"))
                conn.execute(text(f"SET LOCAL statement_timeout = '{int(limits.statement_timeout_ms)}ms'"))
                selection_now = clock.now()
                stmt = select(cat.pk).where(cat.predicate(selection_now, policy))
                if excluded:
                    stmt = stmt.where(cat.pk.not_in(excluded))
                ids = list(conn.execute(stmt.order_by(cat.pk).limit(limits.batch_size)
                                        .with_for_update(skip_locked=True)).scalars())
                selected = len(ids)                   # decide se pode haver mais (antes de filtrar conjuntos)
                tx_now = clock.now()                  # DEPOIS dos bloqueios
                hook(f"maintenance:{cat.name}:locked")
                if ids and isinstance(cat, _WithChildren):
                    ids = _lock_children(conn, cat, ids, excluded, result, pending)
                    hook(f"maintenance:{cat.name}:after_children")
                if ids:
                    deleted = conn.execute(delete(cat.table).where(
                        cat.pk.in_(ids), cat.predicate(tx_now, policy)).returning(cat.pk)).scalars().all()
                    pending[cat.name] = pending.get(cat.name, 0) + len(deleted)
                hook(f"maintenance:{cat.name}:before_commit")
        # COMMIT confirmado: só agora as contagens entram no resultado
        for k, v in pending.items():
            result.removed[k] = result.removed.get(k, 0) + v
        if selected:
            result.batches += 1                       # só lotes com trabalho consomem o orçamento
        else:
            result.empty_checks += 1
        return selected
    except Exception as exc:                          # noqa: BLE001 — lote desfeito; execução encerrada
        result.interrupted = True
        result.failure = _failure_category(exc)
        result.failed_category = cat.name
        raise _Stop() from None


def _lock_children(conn: Connection, cat: _WithChildren, ids: list, excluded: set, result, pending) -> list:
    """Trava os filhos com SKIP LOCKED; conjuntos com algum filho bloqueado ficam de fora (inteiros)."""
    blocked: set = set()
    locked: dict[str, list] = {}
    for child_name, table, pk, fk in cat.children:
        total: dict = {r[0]: r[1] for r in conn.execute(select(fk, func.count()).where(fk.in_(ids)).group_by(fk))}
        rows = list(conn.execute(select(pk, fk).where(fk.in_(ids)).order_by(pk)
                                 .with_for_update(skip_locked=True)).all())
        got: dict = {}
        for _pk, parent in rows:
            got[parent] = got.get(parent, 0) + 1
        blocked |= {p for p, n in total.items() if got.get(p, 0) < n}
        locked[child_name] = rows
    if blocked:
        excluded |= blocked
        result.skipped_locked += len(blocked)
    eligible = [i for i in ids if i not in blocked]
    keep = set(eligible)
    for child_name, table, pk, fk in cat.children:
        child_ids = [r[0] for r in locked[child_name] if r[1] in keep]
        if child_ids:
            n = len(conn.execute(delete(table).where(pk.in_(child_ids)).returning(pk)).scalars().all())
            pending[child_name] = pending.get(child_name, 0) + n
    return eligible
