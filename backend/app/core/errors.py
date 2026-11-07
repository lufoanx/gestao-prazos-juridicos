"""Tratamento global padronizado de erros.

Respostas de erro têm formato consistente e NUNCA expõem stack trace, caminhos do
servidor ou detalhes internos. Erros de validação de DTO (422) são padronizados.
"""
from __future__ import annotations

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from app.core.logging import get_logger

logger = get_logger("prazoai.errors")


def _error_body(code: str, message: str, details: object | None = None) -> dict:
    body: dict = {"error": {"code": code, "message": message}}
    if details is not None:
        body["error"]["details"] = details
    return body


def register_error_handlers(app: FastAPI) -> None:
    @app.exception_handler(StarletteHTTPException)
    async def http_exception_handler(request: Request, exc: StarletteHTTPException):
        # Loga sem corpo/credenciais.
        logger.info("http_error method=%s path=%s status=%s", request.method, request.url.path, exc.status_code)
        return JSONResponse(
            status_code=exc.status_code,
            content=_error_body("http_error", str(exc.detail)),
        )

    @app.exception_handler(RequestValidationError)
    async def validation_exception_handler(request: Request, exc: RequestValidationError):
        # Padroniza a validação de DTOs (422) sem vazar internals.
        details = [
            {"field": ".".join(str(p) for p in err.get("loc", [])), "message": err.get("msg", "")}
            for err in exc.errors()
        ]
        logger.info("validation_error method=%s path=%s", request.method, request.url.path)
        return JSONResponse(status_code=422, content=_error_body("validation_error", "Dados inválidos.", details))

    @app.exception_handler(Exception)
    async def unhandled_exception_handler(request: Request, exc: Exception):
        # Nunca expõe stack trace nem caminhos. Loga internamente de forma genérica.
        logger.error("unhandled_error method=%s path=%s type=%s", request.method, request.url.path, type(exc).__name__)
        return JSONResponse(status_code=500, content=_error_body("internal_error", "Erro interno."))
