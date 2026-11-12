"""Módulo de saúde: GET /api/v1/health (contrato canônico)."""
from __future__ import annotations

from fastapi import APIRouter

from app.core.config import get_settings
from app.schemas import HealthResponse

router = APIRouter(tags=["health"])


@router.get("/health", response_model=HealthResponse, response_model_exclude_none=True,
            summary="Verificação de saúde do serviço")
def health() -> HealthResponse:
    """Retorna o estado do serviço. Sem dados sensíveis.

    No modo padrão (STORAGE=memory) a resposta continua `{"status", "service"}`. No modo
    `postgres`, informa `storage="postgres"` e `durable=true` (estado do BACKEND; não inclui as
    sessões do BFF, que continuam em memória no processo do Next).
    """
    settings = get_settings()
    if settings.storage == "memory":
        return HealthResponse(status="ok", service=settings.service_name)
    return HealthResponse(status="ok", service=settings.service_name, storage=settings.storage,
                          durable=settings.storage_durable)
