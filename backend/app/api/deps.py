"""Dependências de API: serviço de autenticação da instância e usuário autenticado."""
from __future__ import annotations

import hmac
import ipaddress
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


PROXY_SECRET_HEADER = "x-prazoai-proxy-secret"
CLIENT_IP_HEADER = "x-prazoai-client-ip"


def client_ip(request: Request) -> str:
    """IP usado nos limites de taxa.

    Padrão: o IP observado na conexão (X-Forwarded-For é SEMPRE ignorado). Somente se
    `TRUSTED_PROXY_SECRET` estiver configurado e a requisição trouxer o segredo correto
    (comparação em tempo constante) é aceito `X-PrazoAI-Client-IP`, validado como UM endereço
    IPv4/IPv6. Qualquer falha cai no IP observado. O segredo autentica o intermediário; a
    veracidade do IP encaminhado é responsabilidade da infraestrutura que o intermediário usa.
    """
    observed = request.client.host if request.client else "unknown"
    secret: str | None = getattr(request.app.state, "trusted_proxy_secret", None)
    if not secret:
        return observed
    provided = request.headers.get(PROXY_SECRET_HEADER)
    forwarded = request.headers.get(CLIENT_IP_HEADER)
    if provided is None or forwarded is None:
        return observed
    if not hmac.compare_digest(provided.encode("utf-8"), secret.encode("utf-8")):
        return observed
    value = forwarded.strip()
    if not value or len(value) > 45:
        return observed
    try:
        return str(ipaddress.ip_address(value))
    except ValueError:
        return observed
