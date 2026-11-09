"""Rotas /users (Etapa 2): somente o próprio perfil."""
from __future__ import annotations

from fastapi import APIRouter

from app.api.deps import AuthServiceDep, CurrentUser
from app.schemas.auth import PublicUser, UpdateMeRequest

router = APIRouter(prefix="/users", tags=["users"])


@router.get("/me", response_model=PublicUser, response_model_by_alias=True)
def get_me(current: CurrentUser) -> PublicUser:
    return PublicUser.from_user(current.user)


@router.patch("/me", response_model=PublicUser, response_model_by_alias=True)
def update_me(body: UpdateMeRequest, current: CurrentUser, service: AuthServiceDep) -> PublicUser:
    return PublicUser.from_user(service.update_name(current.user.id, body.name))
