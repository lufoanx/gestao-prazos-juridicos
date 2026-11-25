"""Módulo de saúde: GET /api/v1/health (contrato canônico)."""
from __future__ import annotations

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from app.core.config import get_settings
from app.core.logging import get_logger
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


# ---------------------------------------------------------------- disponibilidade (readiness)
ready_router = APIRouter(tags=["health"])


@ready_router.get("/health/ready", summary="Disponibilidade para receber tráfego")
def ready(request: Request) -> JSONResponse:
    """Liveness é /health (processo de pé). Readiness confere o que o tráfego real exige: no modo
    `postgres`, conexão ao banco e revisão do esquema igual à exigida pelo código (somente leitura,
    com prazo curto). Responde 503 sem detalhes (nem destino, nem mensagem do driver)."""
    settings = get_settings()
    auth = getattr(request.app.state, "auth", None)
    engine = getattr(auth, "engine", None)
    if settings.storage != "postgres" or engine is None:
        return JSONResponse({"status": "ready", "storage": settings.storage})
    from sqlalchemy import text  # tardio: o modo memória não carrega SQLAlchemy

    from app.repositories.sql.schema_check import REQUIRED_REVISION

    try:
        with engine.connect() as conn:
            conn.exec_driver_sql("SET TRANSACTION READ ONLY")
            conn.exec_driver_sql("SET LOCAL statement_timeout = 2000")
            revision = conn.execute(text('SELECT version_num FROM "prazoai".alembic_version')).scalar_one_or_none()
            conn.rollback()
    except Exception:  # noqa: BLE001 - qualquer falha = indisponível, sem detalhes
        get_logger("prazoai.health").warning("readiness_database_unavailable")
        return JSONResponse({"status": "unavailable", "checks": {"database": "fail"}}, status_code=503)
    if revision != REQUIRED_REVISION:
        get_logger("prazoai.health").warning("readiness_schema_mismatch")
        return JSONResponse({"status": "unavailable", "checks": {"database": "ok", "schema": "fail"}}, status_code=503)
    checks = {"database": "ok", "schema": "ok"}
    files = getattr(request.app.state, "files", None)
    if files is not None:
        # Doc 28: container existe e é PRIVADO (público ou ausente → indisponível; nada é criado).
        try:
            files.check()
        except Exception:  # noqa: BLE001 - sem detalhes (conta, container, mensagem do SDK)
            get_logger("prazoai.health").warning("readiness_file_storage_unavailable")
            return JSONResponse({"status": "unavailable", "checks": {**checks, "files": "fail"}}, status_code=503)
        checks["files"] = "ok"
    return JSONResponse({"status": "ready", "storage": "postgres", "checks": checks})
