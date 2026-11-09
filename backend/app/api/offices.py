"""Rotas /offices e /memberships (Etapa 3)."""
from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Path, Query, Request, Response, status

from app.api.deps import CurrentUser, OrgServiceDep
from app.api.org_views import (
    invitation_view,
    member_view,
    office_request_view,
    office_view,
    own_membership_view,
)
from app.schemas.org import (
    CreateInvitationRequest,
    CreateOfficeRequest,
    CurrentOfficeResponse,
    InvitationAdminView,
    InvitationCreatedView,
    JoinCodeView,
    LeaveOfficeRequest,
    MemberAdminView,
    MemberPublicView,
    MembersResponse,
    OfficeJoinRequestView,
    OfficeView,
    RemoveMemberRequest,
    UpdateMemberRequest,
    UpdateOfficeRequest,
)
from app.services.org_service import RequestEntry

router = APIRouter(tags=["offices"])

Id = Annotated[str, Path(min_length=1, max_length=64, pattern=r"^[A-Za-z0-9_-]+$")]


def _now(request: Request):
    return request.app.state.auth.clock.now()


@router.post("/offices", status_code=status.HTTP_201_CREATED, response_model=CurrentOfficeResponse)
def create_office(body: CreateOfficeRequest, current: CurrentUser, org: OrgServiceDep) -> CurrentOfficeResponse:
    office, membership = org.create_office(
        current.user.id, body.name, body.role_label, tuple(body.practice_areas)
    )
    return CurrentOfficeResponse(office=office_view(office), membership=own_membership_view(membership))


@router.get("/memberships/me", response_model=CurrentOfficeResponse)
def my_membership(current: CurrentUser, org: OrgServiceDep) -> CurrentOfficeResponse:
    office, membership = org.current(current.user.id)
    return CurrentOfficeResponse(
        office=office_view(office) if office else None,
        membership=own_membership_view(membership) if membership else None,
    )


@router.get("/offices/{office_id}", response_model=OfficeView)
def get_office(office_id: Id, current: CurrentUser, org: OrgServiceDep) -> OfficeView:
    return office_view(org.get_office(current.user.id, office_id))


@router.patch("/offices/{office_id}", response_model=OfficeView)
def update_office(office_id: Id, body: UpdateOfficeRequest, current: CurrentUser, org: OrgServiceDep) -> OfficeView:
    return office_view(org.update_office(current.user.id, office_id, body.name))


@router.get("/offices/{office_id}/members", response_model=MembersResponse)
def list_members(office_id: Id, current: CurrentUser, org: OrgServiceDep) -> MembersResponse:
    actor, entries = org.list_members(current.user.id, office_id)
    admin = actor.is_manager
    return MembersResponse(
        projection="admin" if admin else "public",
        members=[member_view(e, admin=admin) for e in entries],  # type: ignore[arg-type]
    )


@router.patch("/offices/{office_id}/members/{user_id}", response_model=MemberAdminView | MemberPublicView)
def update_member(
    office_id: Id, user_id: Id, body: UpdateMemberRequest, current: CurrentUser, org: OrgServiceDep
) -> MemberPublicView:
    actor, entry = org.update_member(
        current.user.id, office_id, user_id,
        role_label=body.role_label,
        practice_areas=tuple(body.practice_areas) if body.practice_areas is not None else None,
        visibility=body.visibility,
        permissions=frozenset(body.permissions) if body.permissions is not None else None,
    )
    return member_view(entry, admin=actor.is_manager)


@router.post("/offices/{office_id}/members/{user_id}/promote", response_model=MemberAdminView)
def promote(office_id: Id, user_id: Id, current: CurrentUser, org: OrgServiceDep) -> MemberPublicView:
    actor, entry = org.promote(current.user.id, office_id, user_id)
    return member_view(entry, admin=True)


@router.post("/offices/{office_id}/members/{user_id}/remove", status_code=204, response_class=Response)
def remove_member(
    office_id: Id, user_id: Id, body: RemoveMemberRequest, current: CurrentUser, org: OrgServiceDep
) -> Response:
    org.remove_member(current.user.id, office_id, user_id, body.reassign_to)
    return Response(status_code=204)


@router.post("/offices/{office_id}/leave", status_code=204, response_class=Response)
def leave(office_id: Id, body: LeaveOfficeRequest, current: CurrentUser, org: OrgServiceDep) -> Response:
    org.leave(current.user.id, office_id, body.successor_user_id, body.reassign_to)
    return Response(status_code=204)


@router.get("/offices/{office_id}/join-code", response_model=JoinCodeView)
def get_join_code(office_id: Id, current: CurrentUser, org: OrgServiceDep) -> JoinCodeView:
    return JoinCodeView(join_code=org.get_join_code(current.user.id, office_id))


@router.post("/offices/{office_id}/join-code/rotate", response_model=JoinCodeView)
def rotate_join_code(office_id: Id, current: CurrentUser, org: OrgServiceDep) -> JoinCodeView:
    return JoinCodeView(join_code=org.rotate_join_code(current.user.id, office_id))


@router.post(
    "/offices/{office_id}/invitations", status_code=status.HTTP_201_CREATED, response_model=InvitationCreatedView
)
def create_invitation(
    office_id: Id, body: CreateInvitationRequest, request: Request, current: CurrentUser, org: OrgServiceDep
) -> InvitationAdminView:
    invitation, token = org.create_invitation(current.user.id, office_id, body.role_label)
    return invitation_view(invitation, _now(request), token=token)


@router.get("/offices/{office_id}/invitations", response_model=list[InvitationAdminView])
def list_invitations(
    office_id: Id, request: Request, current: CurrentUser, org: OrgServiceDep
) -> list[InvitationAdminView]:
    now = _now(request)
    return [invitation_view(i, now) for i in org.list_invitations(current.user.id, office_id)]


@router.post("/offices/{office_id}/invitations/{invitation_id}/revoke", response_model=InvitationAdminView)
def revoke_invitation(
    office_id: Id, invitation_id: Id, request: Request, current: CurrentUser, org: OrgServiceDep
) -> InvitationAdminView:
    return invitation_view(org.revoke_invitation(current.user.id, office_id, invitation_id), _now(request))


@router.get("/offices/{office_id}/join-requests", response_model=list[OfficeJoinRequestView])
def list_office_requests(
    office_id: Id,
    current: CurrentUser,
    org: OrgServiceDep,
    status_filter: Annotated[
        str | None, Query(alias="status", pattern=r"^(pending|approved|rejected|cancelled)$")
    ] = None,
) -> list[OfficeJoinRequestView]:
    return [office_request_view(e) for e in org.list_office_requests(current.user.id, office_id, status_filter)]


@router.post("/offices/{office_id}/join-requests/{request_id}/approve", response_model=OfficeJoinRequestView)
def approve_request(office_id: Id, request_id: Id, current: CurrentUser, org: OrgServiceDep) -> OfficeJoinRequestView:
    req, membership = org.approve_request(current.user.id, office_id, request_id)
    return office_request_view(RequestEntry(req, org.user_of(req.user_id)))


@router.post("/offices/{office_id}/join-requests/{request_id}/reject", response_model=OfficeJoinRequestView)
def reject_request(office_id: Id, request_id: Id, current: CurrentUser, org: OrgServiceDep) -> OfficeJoinRequestView:
    req = org.reject_request(current.user.id, office_id, request_id)
    return office_request_view(RequestEntry(req, org.user_of(req.user_id)))
