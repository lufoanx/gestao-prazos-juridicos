"""Rotas públicas/autenticadas de convite e solicitações do próprio usuário (Etapa 3).

O token do convite trafega SOMENTE no corpo (nunca no caminho ou query), para não
aparecer em logs de acesso.
"""
from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Path, Request, status

from app.api.deps import CurrentUser, OrgServiceDep, client_ip
from app.api.org_views import office_view, own_membership_view, own_request_view
from app.schemas.org import (
    CreateJoinRequestRequest,
    CurrentOfficeResponse,
    InvitationLookupView,
    InvitationTokenRequest,
    OwnJoinRequestView,
)

router = APIRouter(tags=["invitations"])
Id = Annotated[str, Path(min_length=1, max_length=64, pattern=r"^[A-Za-z0-9_-]+$")]


@router.post("/invitations/lookup", response_model=InvitationLookupView, response_model_exclude_none=True)
def lookup(body: InvitationTokenRequest, request: Request, org: OrgServiceDep) -> InvitationLookupView:
    state, office_name = org.lookup_invitation(body.token, client_ip(request))
    return InvitationLookupView(state=state, office_name=office_name)


@router.post("/invitations/accept", response_model=CurrentOfficeResponse)
def accept(body: InvitationTokenRequest, request: Request, current: CurrentUser, org: OrgServiceDep):
    office, membership = org.accept_invitation(current.user.id, body.token, client_ip(request))
    return CurrentOfficeResponse(office=office_view(office), membership=own_membership_view(membership))


@router.post("/join-requests", status_code=status.HTTP_201_CREATED, response_model=OwnJoinRequestView)
def create_join_request(
    body: CreateJoinRequestRequest, request: Request, current: CurrentUser, org: OrgServiceDep
) -> OwnJoinRequestView:
    req, office = org.create_join_request(current.user.id, body.join_code, client_ip(request))
    return own_request_view(req, office.name)


@router.get("/join-requests/me", response_model=list[OwnJoinRequestView])
def my_join_requests(current: CurrentUser, org: OrgServiceDep) -> list[OwnJoinRequestView]:
    return [own_request_view(r, name) for r, name in org.my_requests(current.user.id)]


@router.post("/join-requests/{request_id}/cancel", response_model=OwnJoinRequestView)
def cancel_join_request(request_id: Id, current: CurrentUser, org: OrgServiceDep) -> OwnJoinRequestView:
    req = org.cancel_request(current.user.id, request_id)
    names = dict((r.id, n) for r, n in org.my_requests(current.user.id))
    return own_request_view(req, names.get(req.id))
