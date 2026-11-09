"""Configuração da aplicação e validação de variáveis de ambiente.

Nenhum segredo fica no código. Valores vêm do ambiente (.env em desenvolvimento,
variáveis do provedor em produção). Sem banco de dados nesta etapa.
"""
from __future__ import annotations

from functools import lru_cache
from typing import Literal

from pydantic import Field, SecretStr, field_validator
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

    # --- Autenticação (Etapa 2: armazenamento EM MEMÓRIA, sem banco) ---
    # Liga/desliga o módulo de autenticação. Em production o armazenamento em memória
    # é BLOQUEADO (create_app falha): é preciso desligar o módulo ou, no futuro,
    # configurar um armazenamento persistente.
    auth_enabled: bool = Field(default=True, alias="AUTH_ENABLED")
    auth_storage: Literal["memory"] = Field(default="memory", alias="AUTH_STORAGE")

    # Segredo de assinatura dos access tokens (HS256). Sem valor padrão no código.
    # Obrigatório em staging/production. Em development/test, se ausente, cada
    # instância da aplicação gera um segredo aleatório efêmero (tokens deixam de valer
    # ao reiniciar — coerente com o armazenamento em memória).
    auth_jwt_secret: SecretStr | None = Field(default=None, alias="AUTH_JWT_SECRET")
    auth_jwt_issuer: str = Field(default="prazoai-backend", alias="AUTH_JWT_ISSUER", min_length=1)
    auth_jwt_audience: str = Field(default="prazoai-api", alias="AUTH_JWT_AUDIENCE", min_length=1)

    # Validades (segundos).
    auth_access_token_ttl_seconds: int = Field(default=900, alias="AUTH_ACCESS_TOKEN_TTL_SECONDS", ge=60, le=3600)
    # Vida máxima ABSOLUTA da sessão/refresh token (a rotação não estende).
    auth_refresh_token_ttl_seconds: int = Field(
        default=7 * 24 * 3600, alias="AUTH_REFRESH_TOKEN_TTL_SECONDS", ge=3600, le=30 * 24 * 3600
    )
    auth_password_reset_ttl_seconds: int = Field(
        default=1800, alias="AUTH_PASSWORD_RESET_TTL_SECONDS", ge=300, le=24 * 3600
    )

    # Limites básicos (em memória, por instância).
    auth_login_max_failures: int = Field(default=5, alias="AUTH_LOGIN_MAX_FAILURES", ge=1, le=100)
    auth_login_window_seconds: int = Field(default=300, alias="AUTH_LOGIN_WINDOW_SECONDS", ge=10, le=24 * 3600)
    auth_forgot_max_requests: int = Field(default=3, alias="AUTH_FORGOT_MAX_REQUESTS", ge=1, le=100)
    auth_forgot_window_seconds: int = Field(default=900, alias="AUTH_FORGOT_WINDOW_SECONDS", ge=10, le=24 * 3600)
    # Cadastro e redefinição: limitados por IP ANTES de qualquer cálculo de Argon2.
    auth_register_max_requests: int = Field(default=10, alias="AUTH_REGISTER_MAX_REQUESTS", ge=1, le=1000)
    auth_register_window_seconds: int = Field(
        default=3600, alias="AUTH_REGISTER_WINDOW_SECONDS", ge=10, le=24 * 3600
    )
    auth_reset_max_requests: int = Field(default=10, alias="AUTH_RESET_MAX_REQUESTS", ge=1, le=1000)
    auth_reset_window_seconds: int = Field(default=900, alias="AUTH_RESET_WINDOW_SECONDS", ge=10, le=24 * 3600)
    # Teto de chaves rastreadas por limitador (excedente usa um balde compartilhado).
    auth_rate_limit_max_keys: int = Field(default=10_000, alias="AUTH_RATE_LIMIT_MAX_KEYS", ge=10, le=1_000_000)
    # Sessões simultâneas por usuário; ao exceder, as mais antigas são removidas.
    auth_max_sessions_per_user: int = Field(default=10, alias="AUTH_MAX_SESSIONS_PER_USER", ge=1, le=100)

    @field_validator("auth_jwt_secret")
    @classmethod
    def _valid_jwt_secret(cls, v: SecretStr | None) -> SecretStr | None:
        if v is None:
            return None
        raw = v.get_secret_value().strip()
        if raw == "":
            return None  # variável vazia = não configurada
        if len(raw.encode("utf-8")) < 32:
            raise ValueError(
                "AUTH_JWT_SECRET deve ter pelo menos 32 bytes "
                '(gere com: python -c "import secrets; print(secrets.token_urlsafe(64))").'
            )
        if raw.lower().startswith(("change", "troque", "placeholder", "example", "exemplo")):
            raise ValueError("AUTH_JWT_SECRET parece um placeholder; gere um valor aleatório.")
        return SecretStr(raw)

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
