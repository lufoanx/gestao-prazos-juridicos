"""Roteador versionado da API (v1).

Montado sob o prefixo canônico API_PREFIX + API_VERSION_PREFIX (ex.: /api/v1).
Nesta etapa (fundação, sem banco) só o módulo de saúde é exposto. Os demais grupos
(/auth, /users, /offices, /deadlines, ...) estão em
docs/backend/04-contratos-api-iniciais.md e entram nas próximas etapas.
"""
from __future__ import annotations

from fastapi import APIRouter

from app.api.health import router as health_router

api_v1_router = APIRouter()
api_v1_router.include_router(health_router)
