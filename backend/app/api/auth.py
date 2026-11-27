"""Rotas /auth (Etapa 2)."""
from __future__ import annotations

from fastapi import APIRouter, Request, Response, status

from app.api.deps import AuthServiceDep, CurrentUser, client_ip
from app.schemas.auth import (
    ForgotPasswordRequest,
    GoogleLoginRequest,
    LoginRequest,
    LoginResponse,
    MeResponse,
    MessageResponse,
    PasswordRecoveryStatus,
    PublicUser,
    RefreshRequest,
    RegisterRequest,
    ResetPasswordRequest,
    TokenResponse,
)

router = APIRouter(prefix="/auth", tags=["auth"])

FORGOT_MESSAGE = "Se o e-mail estiver cadastrado, enviaremos instruções de recuperação."


@router.post("/register", status_code=status.HTTP_201_CREATED, response_model=PublicUser, response_model_by_alias=True)
def register(body: RegisterRequest, request: Request, service: AuthServiceDep) -> PublicUser:
    return PublicUser.from_user(service.register(body.name, body.email, body.password, client_ip(request)))


@router.post("/login", response_model=LoginResponse, response_model_by_alias=True)
def login(body: LoginRequest, request: Request, service: AuthServiceDep) -> LoginResponse:
    pair, user = service.login(body.email, body.password, client_ip(request))
    return LoginResponse(
        access_token=pair.access_token,
        refresh_token=pair.refresh_token,
        expires_in=pair.expires_in,
        user=PublicUser.from_user(user),
    )


@router.post("/google", response_model=LoginResponse, response_model_by_alias=True)
def login_google(body: GoogleLoginRequest, request: Request, service: AuthServiceDep) -> LoginResponse:
    """Entrar com Google: o backend verifica o ID token (assinatura, emissor, público, nonce, e-mail)."""
    pair, user, _created = service.login_with_google(body.id_token, body.nonce, client_ip(request))
    return LoginResponse(
        access_token=pair.access_token,
        refresh_token=pair.refresh_token,
        expires_in=pair.expires_in,
        user=PublicUser.from_user(user),
    )


@router.post("/refresh", response_model=TokenResponse, response_model_by_alias=True)
def refresh(body: RefreshRequest, service: AuthServiceDep) -> TokenResponse:
    pair = service.refresh(body.refresh_token)
    return TokenResponse(access_token=pair.access_token, refresh_token=pair.refresh_token, expires_in=pair.expires_in)


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT, response_class=Response)
def logout(current: CurrentUser, service: AuthServiceDep) -> Response:
    service.logout(current)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/me", response_model=MeResponse, response_model_by_alias=True)
def me(current: CurrentUser) -> MeResponse:
    # Sem membership: escritórios pertencem à próxima etapa.
    return MeResponse(user=PublicUser.from_user(current.user))


@router.post(
    "/forgot-password", status_code=status.HTTP_202_ACCEPTED, response_model=MessageResponse,
    response_model_by_alias=True,
)
def forgot_password(body: ForgotPasswordRequest, request: Request, service: AuthServiceDep) -> MessageResponse:
    """E2: só validação, limites (IP e e-mail) e enfileiramento; nenhum banco, token ou transporte aqui.

    202 neutro para e-mail existente, inexistente ou fila cheia; 429 com Retry-After; 503
    `password_recovery_unavailable` com transporte desabilitado, worker morto ou despachante parando.
    """
    service.request_password_recovery(body.email, client_ip(request))
    return MessageResponse(message=FORGOT_MESSAGE)


@router.get("/password-recovery/status", response_model=PasswordRecoveryStatus, response_model_by_alias=True)
def password_recovery_status(service: AuthServiceDep) -> PasswordRecoveryStatus:
    """Só `{available}`: sem tipo de transporte, host, remetente, fila ou contadores."""
    return PasswordRecoveryStatus(available=service.recovery_available)


@router.post("/reset-password", status_code=status.HTTP_204_NO_CONTENT, response_class=Response)
def reset_password(body: ResetPasswordRequest, request: Request, service: AuthServiceDep) -> Response:
    service.reset_password(body.token, body.new_password, client_ip(request))
    return Response(status_code=status.HTTP_204_NO_CONTENT)
