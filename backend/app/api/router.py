"""Roteador versionado da API (v1).

Montado sob o prefixo canônico API_PREFIX + API_VERSION_PREFIX (ex.: /api/v1).
- Etapa 1: módulo de saúde.
- Etapa 2: /auth e /users (autenticação em memória), quando AUTH_ENABLED=true.
- Etapa 3: /offices, /memberships, /invitations e /join-requests (em memória).
Os demais grupos estão em docs/backend/04-contratos-api-iniciais.md (planejados).
"""
from __future__ import annotations

from fastapi import APIRouter

from app.api.auth import router as auth_router
from app.api.health import router as health_router
from app.api.invitations import router as invitations_router
from app.api.offices import router as offices_router
from app.api.users import router as users_router


def build_api_v1_router(*, auth_enabled: bool, offices_enabled: bool = False) -> APIRouter:
    router = APIRouter()
    router.include_router(health_router)
    if auth_enabled:
        router.include_router(auth_router)
        router.include_router(users_router)
    if auth_enabled and offices_enabled:
        router.include_router(offices_router)
        router.include_router(invitations_router)
    return router


# Compatibilidade: roteador com todos os módulos.
api_v1_router = build_api_v1_router(auth_enabled=True, offices_enabled=True)
