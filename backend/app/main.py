"""Fundação do backend PrazoAI (FastAPI) — sem banco de dados.

Decisão oficial do projeto: o backend é Python/FastAPI, preservando a tecnologia existente.
Ver docs/backend/02-arquitetura-proposta.md.

Esta etapa NÃO usa banco de dados, ORM nem autenticação real. Expõe apenas a
fundação versionada: GET /api/v1/health (contrato canônico), CORS por variável de
ambiente, prefixo global /api + versão /v1, validação de ambiente, tratamento global
de erros, logs básicos e OpenAPI em dev. Os endpoints legados (/ e /calcular-prazo)
são preservados. GET /api/health é mantido como ALIAS LEGADO de compatibilidade.
"""
from __future__ import annotations

from typing import Annotated

from fastapi import FastAPI, Query
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from pydantic import AfterValidator

from app.api.router import api_v1_router
from app.core.config import get_settings
from app.core.errors import register_error_handlers
from app.core.logging import configure_logging, get_logger
from app.services.prazo_service import EntradaPrazoInvalidaError, calcular_prazo, validar_data_inicial


def _data_inicial_valida(valor: str) -> str:
    # Reaproveita a regra do serviço (fonte única); o ValueError vira 422 padronizado.
    validar_data_inicial(valor)
    return valor


DataInicialQuery = Annotated[
    str,
    Query(description="Data inicial no formato DD/MM/AAAA."),
    AfterValidator(_data_inicial_valida),
]
DiasQuery = Annotated[int, Query(ge=1, description="Quantidade de dias úteis (inteiro >= 1).")]


def create_app() -> FastAPI:
    settings = get_settings()
    configure_logging(settings.log_level)
    logger = get_logger("prazoai")

    # Swagger/OpenAPI apenas fora de produção.
    docs_url = None if settings.is_production else "/docs"
    redoc_url = None if settings.is_production else "/redoc"
    openapi_url = None if settings.is_production else "/openapi.json"

    app = FastAPI(
        title="PrazoAI Backend",
        version="0.1.0",
        description="Fundação do backend do PrazoAI (sem banco de dados).",
        docs_url=docs_url,
        redoc_url=redoc_url,
        openapi_url=openapi_url,
    )

    # CORS configurável por variável de ambiente (CORS_ORIGINS). Com credenciais,
    # a origem "*" é insegura: é descartada (ver Settings.cors_origin_list).
    if settings.cors_has_wildcard:
        logger.warning("cors_wildcard_ignored: '*' é inseguro com credenciais; liste origens explícitas.")
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origin_list,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    # Tratamento global de erros (sem stack trace/caminhos).
    register_error_handlers(app)

    # API versionada: contrato canônico sob /api/v1.
    app.include_router(api_v1_router, prefix=settings.api_base)

    # Alias LEGADO de compatibilidade: /api/health → mesmo módulo de saúde.
    # Documentado como legado; o contrato canônico é /api/v1/health.
    if settings.enable_legacy_health_alias:
        app.include_router(api_v1_router, prefix=settings.api_prefix, include_in_schema=False)

    # --- Endpoints legados preservados (comportamento atual do backend) ---
    @app.get("/", tags=["legacy"])
    def read_root():
        return {"message": "API do sistema de prazos jurídicos"}

    @app.get("/calcular-prazo", tags=["legacy"])
    def calcular(data_inicial: DataInicialQuery, dias: DiasQuery):
        # Observação: cálculo demonstrativo pré-existente; NÃO é cálculo processual oficial.
        # Entradas inválidas → 422 no formato padronizado (Issue #3), nunca 500.
        try:
            resultado = calcular_prazo(data_inicial, dias)
        except EntradaPrazoInvalidaError as exc:
            raise RequestValidationError(
                [{"type": "value_error", "loc": ("query", exc.campo), "msg": exc.mensagem}]
            ) from exc
        return {"data_inicial": data_inicial, "dias": dias, "data_final": resultado}

    logger.info("app_ready environment=%s api_base=%s", settings.environment, settings.api_base)
    return app


app = create_app()
