"""Dependências de API: serviço de autenticação da instância e usuário autenticado."""
from __future__ import annotations

from typing import Annotated

from fastapi import Depends, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from app.core.errors import AppError
from app.services.auth_service import AuthenticatedUser, AuthService
from app.services.org_service import OrgService

_bearer = HTTPBearer(auto_error=False, description="Access token (Bearer).")


def get_auth_service(request: Request) -> AuthService:
    container = getattr(request.app.state, "auth", None)
    if container is None:  # módulo desligado
        raise AppError(404, "http_error", "Not Found")
    return container.service


def get_current_user(
    service: Annotated[AuthService, Depends(get_auth_service)],
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(_bearer)],
) -> AuthenticatedUser:
    """Valida o JWT E a sessão no servidor (tokens revogados deixam de valer na hora)."""
    if credentials is None or credentials.scheme.lower() != "bearer" or not credentials.credentials:
        raise AppError(401, "not_authenticated", "Não autenticado.", headers={"WWW-Authenticate": "Bearer"})
    return service.authenticate(credentials.credentials)


def get_org_service(request: Request) -> OrgService:
    container = getattr(request.app.state, "org", None)
    if container is None:  # módulo desligado
        raise AppError(404, "http_error", "Not Found")
    return container.service


AuthServiceDep = Annotated[AuthService, Depends(get_auth_service)]
OrgServiceDep = Annotated[OrgService, Depends(get_org_service)]
CurrentUser = Annotated[AuthenticatedUser, Depends(get_current_user)]


def client_ip(request: Request) -> str:
    # Sem confiar em X-Forwarded-For (cabeçalho controlado pelo cliente).
    return request.client.host if request.client else "unknown"
