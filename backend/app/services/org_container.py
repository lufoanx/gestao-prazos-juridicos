"""Composição do módulo de escritórios por instância da aplicação (Etapa 3)."""
from __future__ import annotations

from dataclasses import dataclass

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
    store: MemoryOrgStore
    deadline_store: MemoryDeadlineStore
    unit_of_work: MemoryUnitOfWork


def ensure_offices_allowed(settings: Settings) -> None:
    """Bloqueio em production, avaliado mesmo com a autenticação desligada."""
    if settings.offices_active and settings.is_production:
        raise InMemoryOrgBlockedError(
            "Escritórios usam armazenamento em memória: bloqueado em ENVIRONMENT=production "
            "(defina OFFICES_ENABLED=false ou configure persistência)."
        )
    if settings.offices_active and not settings.auth_enabled:
        raise ValueError("OFFICES_ENABLED=true exige AUTH_ENABLED=true.")


def build_org_container(
    settings: Settings,
    *,
    users: UserRepository,
    clock: Clock,
    responsibilities: ResponsibilityPort | None = None,
) -> OrgContainer:
    ensure_offices_allowed(settings)
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
    uow = MemoryUnitOfWork(store, deadline_store, intimation_store, notification_store)

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
