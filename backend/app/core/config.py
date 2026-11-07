"""Configuração da aplicação e validação de variáveis de ambiente.

Nenhum segredo fica no código. Valores vêm do ambiente (.env em desenvolvimento,
variáveis do provedor em produção). Sem banco de dados nesta etapa.
"""
from __future__ import annotations

from functools import lru_cache

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Variáveis de ambiente validadas da fundação do backend."""

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
        case_sensitive=False,
    )

    # Identificação do serviço (usada em /api/health).
    service_name: str = Field(default="prazoai-backend", alias="SERVICE_NAME")

    # Ambiente: "development" habilita Swagger; "production" desabilita.
    environment: str = Field(default="development", alias="ENVIRONMENT")

    # Prefixo global das rotas da API.
    api_prefix: str = Field(default="/api", alias="API_PREFIX")

    # Prefixo de versão da API (versionamento real). Contrato canônico: /api/v1.
    api_version_prefix: str = Field(default="/v1", alias="API_VERSION_PREFIX")

    # Expor GET /api/health como alias legado de compatibilidade (contrato canônico é /api/v1/health).
    enable_legacy_health_alias: bool = Field(default=True, alias="ENABLE_LEGACY_HEALTH_ALIAS")

    # Origens permitidas para CORS (lista separada por vírgula).
    cors_origins: str = Field(default="http://localhost:3000", alias="CORS_ORIGINS")

    # Nível de log (sem dados sensíveis).
    log_level: str = Field(default="INFO", alias="LOG_LEVEL")

    @field_validator("environment")
    @classmethod
    def _valid_environment(cls, v: str) -> str:
        allowed = {"development", "test", "staging", "production"}
        value = (v or "development").strip().lower()
        if value not in allowed:
            raise ValueError(f"ENVIRONMENT inválido: {v!r}. Use um de {sorted(allowed)}.")
        return value

    @field_validator("api_prefix")
    @classmethod
    def _valid_prefix(cls, v: str) -> str:
        value = (v or "/api").strip()
        if not value.startswith("/"):
            raise ValueError("API_PREFIX deve começar com '/'.")
        return value.rstrip("/") or "/api"

    @field_validator("api_version_prefix")
    @classmethod
    def _valid_version_prefix(cls, v: str) -> str:
        value = (v or "/v1").strip()
        if not value.startswith("/"):
            raise ValueError("API_VERSION_PREFIX deve começar com '/'.")
        return value.rstrip("/") or "/v1"

    @property
    def is_production(self) -> bool:
        return self.environment == "production"

    @property
    def api_base(self) -> str:
        """Base canônica versionada, ex.: /api/v1."""
        return f"{self.api_prefix}{self.api_version_prefix}"

    @property
    def cors_origin_list(self) -> list[str]:
        """Origens de CORS validadas.

        Com allow_credentials=True, a origem curinga "*" é insegura e é rejeitada:
        é descartada da lista (em produção liste origens explícitas).
        """
        origins = [o.strip() for o in self.cors_origins.split(",") if o.strip()]
        return [o for o in origins if o != "*"]

    @property
    def cors_has_wildcard(self) -> bool:
        return any(o.strip() == "*" for o in self.cors_origins.split(","))


@lru_cache
def get_settings() -> Settings:
    """Retorna as configurações (memoizadas). Lança erro claro se inválidas."""
    return Settings()
