"""Módulo de saúde: GET /api/v1/health (contrato canônico)."""
from __future__ import annotations

from fastapi import APIRouter

from app.core.config import get_settings
from app.schemas import HealthResponse

router = APIRouter(tags=["health"])


@router.get("/health", response_model=HealthResponse, summary="Verificação de saúde do serviço")
def health() -> HealthResponse:
    """Retorna o estado do serviço. Sem dados sensíveis."""
    settings = get_settings()
    return HealthResponse(status="ok", service=settings.service_name)
