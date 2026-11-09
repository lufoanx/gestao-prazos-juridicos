"""Projeções da Etapa 3: o que cada solicitante pode ver (lista branca explícita)."""
from __future__ import annotations

from datetime import datetime

from app.domain.org import PERMISSIONS, Invitation, JoinRequest, Membership, Office
from app.schemas.org import (
    InvitationAdminView,
    InvitationCreatedView,
    MemberAdminView,
    MemberPublicView,
    OfficeJoinRequestView,
    OfficeView,
    OwnJoinRequestView,
    OwnMembershipView,
    RequesterView,
)
from app.services.org_service import MemberEntry, RequestEntry


def _ordered(perms: frozenset[str]) -> list[str]:
    return [p for p in PERMISSIONS if p in perms]


def office_view(office: Office) -> OfficeView:
    return OfficeView(id=office.id, name=office.name, created_at=office.created_at)


def own_membership_view(m: Membership) -> OwnMembershipView:
    return OwnMembershipView(
        office_id=m.office_id, role_label=m.role_label, practice_areas=list(m.practice_areas),
        permissions=_ordered(m.permissions), visibility=m.visibility, joined_at=m.joined_at,
    )


def member_view(entry: MemberEntry, *, admin: bool) -> MemberPublicView:
    m, user = entry.membership, entry.user
    name = user.name if user else ""
    if not admin:
        return MemberPublicView(
            user_id=m.user_id, name=name, role_label=m.role_label, practice_areas=list(m.practice_areas)
        )
    return MemberAdminView(
        user_id=m.user_id, name=name, role_label=m.role_label, practice_areas=list(m.practice_areas),
        email=user.email if user else "", permissions=_ordered(m.permissions),
        visibility=m.visibility, joined_at=m.joined_at,
    )


def invitation_view(inv: Invitation, now: datetime, token: str | None = None) -> InvitationAdminView:
    if token:
        return InvitationCreatedView(
            id=inv.id, role_label=inv.role_label, state=inv.state(now), created_at=inv.created_at,
            expires_at=inv.expires_at, closed_at=inv.closed_at, token=token,
        )
    return InvitationAdminView(
        id=inv.id, role_label=inv.role_label, state=inv.state(now), created_at=inv.created_at,
        expires_at=inv.expires_at, closed_at=inv.closed_at,
    )


def own_request_view(req: JoinRequest, office_name: str | None) -> OwnJoinRequestView:
    return OwnJoinRequestView(
        id=req.id, office_name=office_name, status=req.status, created_at=req.created_at, decided_at=req.decided_at
    )


def office_request_view(entry: RequestEntry) -> OfficeJoinRequestView:
    req, user = entry.request, entry.user
    requester = RequesterView(user_id=user.id, name=user.name, email=user.email) if user else None
    return OfficeJoinRequestView(
        id=req.id, requester=requester, status=req.status, created_at=req.created_at, decided_at=req.decided_at
    )
