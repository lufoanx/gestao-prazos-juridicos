"""Composição do módulo de escritórios por instância da aplicação (Etapa 3)."""
from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from app.core.clock import Clock
from app.core.config import Settings
from app.repositories.auth import UserRepository
from app.repositories.deadlines_memory import DeadlineLimits, MemoryDeadlineStore
from app.repositories.intimations_memory import (
    IntimationLimits,
    MemoryIntimationStore,
    MemoryNotificationStore,
    NotificationLimits,
)
from app.repositories.org_memory import MemoryOrgStore
from app.repositories.unit_of_work import MemoryUnitOfWork
from app.security.rate_limit import RateLimiter
from app.services.auth_container import InMemoryAuthBlockedError
from app.services.org_service import OrgLimits, OrgService
from app.services.responsibility_port import DeadlineResponsibilityPort, ResponsibilityPort


class InMemoryOrgBlockedError(InMemoryAuthBlockedError):
    """Armazenamento de escritórios em memória não é permitido em production."""


@dataclass
class OrgContainer:
    service: OrgService
    store: MemoryOrgStore | None                 # None no modo postgres
    deadline_store: MemoryDeadlineStore | None   # None no modo postgres
    unit_of_work: Any                            # UnitOfWork: MemoryUnitOfWork ou SqlUnitOfWork


def ensure_offices_allowed(settings: Settings) -> None:
    """Bloqueio em production, avaliado mesmo com a autenticação desligada."""
    if settings.offices_active and settings.is_production:
        raise InMemoryOrgBlockedError(
            "Escritórios: ENVIRONMENT=production continua bloqueado (defina OFFICES_ENABLED=false)."
        )
    if settings.offices_active and not settings.auth_enabled:
        raise ValueError("OFFICES_ENABLED=true exige AUTH_ENABLED=true.")


def build_org_container(
    settings: Settings,
    *,
    users: UserRepository,
    clock: Clock,
    responsibilities: ResponsibilityPort | None = None,
    engine: Any = None,
    sql_checkpoint: Callable[[str], None] | None = None,
) -> OrgContainer:
    ensure_offices_allowed(settings)
    if settings.storage == "postgres":
        # Domínio no PostgreSQL com o MESMO engine da autenticação (sem fallback para memória).
        if engine is None:
            raise RuntimeError("STORAGE=postgres exige o engine da autenticação para o domínio.")
        from app.repositories.sql.domain import DomainLimits, SqlUnitOfWork

        uow: Any = SqlUnitOfWork(engine, DomainLimits(
            deadlines_per_scope=settings.deadlines_max_per_scope,
            comments_per_deadline=settings.deadlines_max_comments,
            history_per_deadline=settings.deadlines_max_history,
            intimations_per_scope=settings.intimations_max_per_scope,
            events_per_intimation=settings.intimations_max_events,
            notifications_per_recipient=settings.notifications_max_per_recipient,
        ), checkpoint=sql_checkpoint)
        store = deadline_store = None
    else:
        uow, store, deadline_store = _memory_unit_of_work(settings)
    return _compose(settings, uow, store, deadline_store, users=users, clock=clock, responsibilities=responsibilities)


def _memory_unit_of_work(settings: Settings):
    store = MemoryOrgStore(closed_retention_seconds=settings.org_closed_retention_seconds)
    deadline_store = MemoryDeadlineStore(DeadlineLimits(
        max_per_scope=settings.deadlines_max_per_scope,
        max_comments_per_deadline=settings.deadlines_max_comments,
        max_history_per_deadline=settings.deadlines_max_history,
    ))
    intimation_store = MemoryIntimationStore(IntimationLimits(
        max_per_scope=settings.intimations_max_per_scope,
        max_events_per_intimation=settings.intimations_max_events,
        discard_retention_seconds=settings.intimations_discard_retention_seconds,
    ))
    notification_store = MemoryNotificationStore(NotificationLimits(
        max_per_recipient=settings.notifications_max_per_recipient,
        read_retention_seconds=settings.notifications_read_retention_seconds,
    ))
    return MemoryUnitOfWork(store, deadline_store, intimation_store, notification_store), store, deadline_store


def _compose(settings: Settings, uow: Any, store, deadline_store, *, users: UserRepository, clock: Clock,
             responsibilities: ResponsibilityPort | None) -> OrgContainer:
    def limiter(max_events: int, window: int) -> RateLimiter:
        return RateLimiter(max_events, window, clock, max_keys=settings.auth_rate_limit_max_keys)

    service = OrgService(
        repo=uow,
        unit_of_work=uow,
        users=users,
        clock=clock,
        responsibilities=responsibilities or DeadlineResponsibilityPort(),
        limits=OrgLimits(
            invite_ttl_seconds=settings.org_invite_ttl_seconds,
            max_pending_invites_per_office=settings.org_max_pending_invites_per_office,
            max_pending_requests_per_office=settings.org_max_pending_requests_per_office,
            max_pending_requests_per_user=settings.org_max_pending_requests_per_user,
        ),
        invite_create_limiter=limiter(settings.org_invite_create_max, settings.org_invite_create_window_seconds),
        invite_lookup_limiter=limiter(settings.org_invite_lookup_max, settings.org_invite_lookup_window_seconds),
        invite_accept_limiter=limiter(settings.org_invite_accept_max, settings.org_invite_accept_window_seconds),
        join_request_limiter=limiter(settings.org_join_request_max, settings.org_join_request_window_seconds),
    )
    return OrgContainer(service=service, store=store, deadline_store=deadline_store, unit_of_work=uow)
