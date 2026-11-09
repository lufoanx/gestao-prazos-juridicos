"""Backend PrazoAI (FastAPI) — sem banco de dados.

Decisão oficial do projeto: o backend é Python/FastAPI, preservando a tecnologia existente.
Ver docs/backend/02-arquitetura-proposta.md.

Etapa 1 (fundação): GET /api/v1/health (contrato canônico), CORS por variável de ambiente,
prefixo global /api + versão /v1, validação de ambiente, tratamento global de erros, logs
básicos e OpenAPI em dev. Endpoints legados (/ e /calcular-prazo) preservados.
GET /api/health é mantido como ALIAS LEGADO, restrito ao módulo de saúde.

Etapa 2: autenticação e usuários com armazenamento EM MEMÓRIA por instância (sem banco),
bloqueado em production. Ver docs/backend/06-etapa-2-autenticacao.md.
"""
from __future__ import annotations

from datetime import datetime
from re import fullmatch
from typing import Annotated

from fastapi import FastAPI, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import AfterValidator

from app.api.health import router as health_router
from app.api.router import build_api_v1_router
from app.core.clock import Clock
from app.core.config import get_settings
from app.core.errors import register_error_handlers
from app.core.logging import configure_logging, get_logger
from app.security.passwords import PasswordHasher
from app.services.auth_container import build_auth_container
from app.services.deadline_service import DeadlineService
from app.services.intimation_service import IntimationService
from app.services.notification_service import NotificationService
from app.services.org_container import build_org_container, ensure_offices_allowed
from app.services.password_reset_delivery import PasswordResetDelivery
from app.services.prazo_service import calcular_prazo
from app.services.processing_port import ProcessingPort
from app.services.responsibility_port import ResponsibilityPort

FORMATO_DATA = "%d/%m/%Y"


def validar_data_inicial(valor: str) -> str:
    """Aceita apenas DD/MM/AAAA e datas que existem no calendário."""
    if fullmatch(r"\d{2}/\d{2}/\d{4}", valor) is None:
        raise ValueError("data_inicial deve estar no formato DD/MM/AAAA")

    try:
        datetime.strptime(valor, FORMATO_DATA)
    except ValueError as exc:
        raise ValueError("data_inicial não existe no calendário") from exc

    return valor


DataInicial = Annotated[str, AfterValidator(validar_data_inicial)]


def create_app(
    *,
    clock: Clock | None = None,
    password_reset_delivery: PasswordResetDelivery | None = None,
    password_hasher: PasswordHasher | None = None,
    responsibility_port: ResponsibilityPort | None = None,
    processing_port: ProcessingPort | None = None,
) -> FastAPI:
    """Cria uma instância isolada da aplicação.

    Parâmetros opcionais permitem injetar relógio, entrega de recuperação e hasher
    (testes). O estado de autenticação em memória pertence a esta instância.
    """
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

    # Autenticação (Etapa 2): estado EM MEMÓRIA por instância. Bloqueado em production.
    # Etapa 6.1: segredo do intermediário (BFF) para aceitar o IP do cliente; None = desativado.
    app.state.trusted_proxy_secret = (
        settings.trusted_proxy_secret.get_secret_value() if settings.trusted_proxy_secret else None
    )
    app.state.auth = None
    if settings.auth_enabled:
        container = build_auth_container(
            settings, clock=clock, delivery=password_reset_delivery, password_hasher=password_hasher
        )
        app.state.auth = container
        logger.warning(
            "auth_in_memory_store: dados perdidos ao reiniciar; incompatível com múltiplos workers; "
            "não usar em produção."
        )
        if container.ephemeral_secret:
            logger.warning("auth_ephemeral_jwt_secret: AUTH_JWT_SECRET ausente; segredo aleatório por instância.")

    # Escritórios/equipe (Etapa 3): mesmo estado por instância e mesmo bloqueio em production.
    # A verificação ocorre mesmo com a autenticação desligada.
    ensure_offices_allowed(settings)
    app.state.org = None
    if settings.offices_active and app.state.auth is not None:
        app.state.org = build_org_container(
            settings, users=app.state.auth.users, clock=app.state.auth.clock, responsibilities=responsibility_port
        )
    # Prazos (Etapa 4): mesma unidade de trabalho (ordem de locks escritórios → prazos).
    app.state.deadlines = None
    app.state.intimations = None
    app.state.notifications = None
    if app.state.org is not None:
        app.state.deadlines = DeadlineService(
            unit_of_work=app.state.org.unit_of_work, clock=app.state.auth.clock,
            timezone=settings.deadlines_timezone, soon_days=settings.deadlines_soon_days,
        )
        # Intimações e notificações (Etapa 5): mesma unidade de trabalho; processamento indisponível.
        app.state.intimations = IntimationService(
            unit_of_work=app.state.org.unit_of_work, clock=app.state.auth.clock, processing=processing_port,
        )
        app.state.notifications = NotificationService(
            unit_of_work=app.state.org.unit_of_work, clock=app.state.auth.clock,
        )

    # API versionada: contrato canônico sob /api/v1.
    app.include_router(
        build_api_v1_router(auth_enabled=settings.auth_enabled, offices_enabled=app.state.org is not None),
        prefix=settings.api_base,
    )

    # Alias LEGADO de compatibilidade: SOMENTE /api/health (não expõe /api/auth, /api/users).
    # Documentado como legado; o contrato canônico é /api/v1/health.
    if settings.enable_legacy_health_alias:
        app.include_router(health_router, prefix=settings.api_prefix, include_in_schema=False)

    # --- Endpoints legados preservados (comportamento atual do backend) ---
    @app.get("/", tags=["legacy"])
    def read_root():
        return {"message": "API do sistema de prazos jurídicos"}

    @app.get("/calcular-prazo", tags=["legacy"])
    def calcular(
        data_inicial: DataInicial,
        dias: Annotated[int, Query(ge=1)],
    ):
        # Observação: cálculo demonstrativo pré-existente; NÃO é cálculo processual oficial.
        try:
            resultado = calcular_prazo(data_inicial, dias)
        except ValueError as exc:
            # Defesa da camada de serviço: mantém o formato padronizado de validação.
            return JSONResponse(
                status_code=422,
                content={"error": {"code": "validation_error", "message": str(exc)}},
            )
        return {"data_inicial": data_inicial, "dias": dias, "data_final": resultado}

    logger.info("app_ready environment=%s api_base=%s", settings.environment, settings.api_base)
    return app


app = create_app()
