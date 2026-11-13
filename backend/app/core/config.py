"""Configuração da aplicação e validação de variáveis de ambiente.

Nenhum segredo fica no código. Valores vêm do ambiente (.env em desenvolvimento,
variáveis do provedor em produção). Persistência: P1 (fundação) — a aplicação continua usando só
memória (`STORAGE=memory`); o banco é usado apenas por comandos explícitos (migrations, verificação)
e pelos testes de fundação.
"""
from __future__ import annotations

from functools import lru_cache
from typing import Literal

from pydantic import Field, SecretStr, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class ProductionNotReleasedError(RuntimeError):
    """ENVIRONMENT=production ainda não está liberado (doc 15, §5.6): bloqueio por CÓDIGO.

    Vale para qualquer combinação de AUTH_ENABLED, OFFICES_ENABLED e STORAGE. Configurar um banco
    não libera produção; isso exige uma entrega própria e aprovada de prontidão.
    """


def ensure_not_production(settings: "Settings") -> None:
    if settings.is_production:
        raise ProductionNotReleasedError(
            "ENVIRONMENT=production ainda não está liberado: a aplicação recusa iniciar em produção "
            "(independentemente de AUTH_ENABLED, OFFICES_ENABLED e STORAGE) até a entrega de prontidão."
        )


class Settings(BaseSettings):
    """Variáveis de ambiente validadas da fundação do backend."""

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
        case_sensitive=False,
        # Erros de validação NUNCA exibem os valores recebidos: validadores de modelo incluiriam o
        # dicionário inteiro (com DATABASE_URL e segredos) no `input_value` da mensagem.
        hide_input_in_errors=True,
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

    # --- Persistência (P1 fundação, P2 esquema, P3 autenticação) ---
    # STORAGE (doc 15, §5.6; modos FINAIS desde a P4):
    #   "memory" (padrão) — tudo em memória (testes rápidos e desenvolvimento);
    #   "postgres" — autenticação E domínio no PostgreSQL (development/test; production segue bloqueada).
    # O modo intermediário "auth-postgres" e ALLOW_VOLATILE_DOMAIN (P3) foram REMOVIDOS na P4.
    storage: str = Field(default="memory", alias="STORAGE")
    # URL de conexão (segredo). NÃO é validada aqui de propósito: erros do pydantic incluem o valor
    # recebido, o que exporia a senha. A validação (sem credenciais na mensagem) fica em
    # app/db/config.py e só ocorre quando um comando explícito precisa do banco. No modo memory a
    # presença desta variável NÃO causa conexão (apenas um aviso no startup).
    database_url: SecretStr | None = Field(default=None, alias="DATABASE_URL")
    database_pool_size: int = Field(default=5, alias="DATABASE_POOL_SIZE", ge=1, le=50)
    database_max_overflow: int = Field(default=5, alias="DATABASE_MAX_OVERFLOW", ge=0, le=50)
    database_pool_timeout_seconds: int = Field(default=10, alias="DATABASE_POOL_TIMEOUT_SECONDS", ge=1, le=120)
    database_connect_timeout_seconds: int = Field(default=5, alias="DATABASE_CONNECT_TIMEOUT_SECONDS", ge=1, le=60)
    database_lock_timeout_ms: int = Field(default=5_000, alias="DATABASE_LOCK_TIMEOUT_MS", ge=100, le=60_000)
    database_statement_timeout_ms: int = Field(
        default=15_000, alias="DATABASE_STATEMENT_TIMEOUT_MS", ge=1_000, le=600_000
    )

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
    # Rotações de refresh por sessão. Padrão 1000 > ~672 rotações de uma sessão de 7 dias
    # renovada a cada 15 min. Ao atingir o teto, o próximo refresh encerra a sessão.
    auth_max_refresh_rotations_per_session: int = Field(
        default=1000, alias="AUTH_MAX_REFRESH_ROTATIONS_PER_SESSION", ge=10, le=100_000
    )

    # --- Escritórios, equipe e permissões (Etapa 3: armazenamento EM MEMÓRIA) ---
    # None = acompanha AUTH_ENABLED. Depende da autenticação. Bloqueado em production
    # (mesmo com AUTH_ENABLED=false, se OFFICES_ENABLED=true for definido explicitamente).
    offices_enabled: bool | None = Field(default=None, alias="OFFICES_ENABLED")
    org_invite_ttl_seconds: int = Field(
        default=7 * 24 * 3600, alias="ORG_INVITE_TTL_SECONDS", ge=3600, le=30 * 24 * 3600
    )
    org_invite_create_max: int = Field(default=20, alias="ORG_INVITE_CREATE_MAX", ge=1, le=1000)
    org_invite_create_window_seconds: int = Field(
        default=3600, alias="ORG_INVITE_CREATE_WINDOW_SECONDS", ge=10, le=24 * 3600
    )
    org_invite_lookup_max: int = Field(default=30, alias="ORG_INVITE_LOOKUP_MAX", ge=1, le=1000)
    org_invite_lookup_window_seconds: int = Field(
        default=900, alias="ORG_INVITE_LOOKUP_WINDOW_SECONDS", ge=10, le=24 * 3600
    )
    org_invite_accept_max: int = Field(default=10, alias="ORG_INVITE_ACCEPT_MAX", ge=1, le=1000)
    org_invite_accept_window_seconds: int = Field(
        default=900, alias="ORG_INVITE_ACCEPT_WINDOW_SECONDS", ge=10, le=24 * 3600
    )
    org_join_request_max: int = Field(default=10, alias="ORG_JOIN_REQUEST_MAX", ge=1, le=1000)
    org_join_request_window_seconds: int = Field(
        default=3600, alias="ORG_JOIN_REQUEST_WINDOW_SECONDS", ge=10, le=24 * 3600
    )
    org_max_pending_invites_per_office: int = Field(
        default=50, alias="ORG_MAX_PENDING_INVITES_PER_OFFICE", ge=1, le=1000
    )
    org_max_pending_requests_per_office: int = Field(
        default=200, alias="ORG_MAX_PENDING_REQUESTS_PER_OFFICE", ge=1, le=10_000
    )
    org_max_pending_requests_per_user: int = Field(default=5, alias="ORG_MAX_PENDING_REQUESTS_PER_USER", ge=1, le=50)
    org_closed_retention_seconds: int = Field(
        default=30 * 24 * 3600, alias="ORG_CLOSED_RETENTION_SECONDS", ge=24 * 3600, le=365 * 24 * 3600
    )

    # --- Prazos (Etapa 4: EM MEMÓRIA; ativo junto com escritórios) ---
    deadlines_timezone: str = Field(default="America/Sao_Paulo", alias="DEADLINES_TIMEZONE")
    deadlines_soon_days: int = Field(default=3, alias="DEADLINES_SOON_DAYS", ge=0, le=30)
    deadlines_max_per_scope: int = Field(default=10_000, alias="DEADLINES_MAX_PER_SCOPE", ge=1, le=1_000_000)
    deadlines_max_comments: int = Field(default=1_000, alias="DEADLINES_MAX_COMMENTS", ge=1, le=100_000)
    deadlines_max_history: int = Field(default=2_000, alias="DEADLINES_MAX_HISTORY", ge=10, le=100_000)

    # --- Intimações e notificações (Etapa 5: EM MEMÓRIA; ativas junto com escritórios) ---
    intimations_max_per_scope: int = Field(default=5_000, alias="INTIMATIONS_MAX_PER_SCOPE", ge=1, le=1_000_000)
    intimations_max_events: int = Field(default=500, alias="INTIMATIONS_MAX_EVENTS", ge=10, le=100_000)
    intimations_discard_retention_seconds: int = Field(
        default=30 * 24 * 3600, alias="INTIMATIONS_DISCARD_RETENTION_SECONDS", ge=24 * 3600, le=365 * 24 * 3600
    )
    notifications_max_per_recipient: int = Field(
        default=1_000, alias="NOTIFICATIONS_MAX_PER_RECIPIENT", ge=10, le=100_000
    )
    notifications_read_retention_seconds: int = Field(
        default=90 * 24 * 3600, alias="NOTIFICATIONS_READ_RETENTION_SECONDS", ge=24 * 3600, le=730 * 24 * 3600
    )

    # --- E-mail transacional (E1 do doc 21): configuração e transporte isolado ---
    # Padrão `disabled`: nenhum e-mail é enviado e nada muda no comportamento existente. A E1 NÃO
    # liga o transporte à recuperação de senha (isso é da E2, ainda não aprovada).
    email_transport: str = Field(default="disabled", alias="EMAIL_TRANSPORT")
    public_app_origin: str | None = Field(default=None, alias="PUBLIC_APP_ORIGIN")
    email_from: str | None = Field(default=None, alias="EMAIL_FROM")
    smtp_host: str | None = Field(default=None, alias="SMTP_HOST")
    smtp_port: int = Field(default=587, alias="SMTP_PORT", ge=1, le=65535)
    smtp_security: str = Field(default="starttls", alias="SMTP_SECURITY")
    smtp_allow_insecure_local: bool = Field(default=False, alias="SMTP_ALLOW_INSECURE_LOCAL")
    smtp_username: str | None = Field(default=None, alias="SMTP_USERNAME")
    smtp_password: SecretStr | None = Field(default=None, alias="SMTP_PASSWORD")
    smtp_ca_file: str | None = Field(default=None, alias="SMTP_CA_FILE")
    smtp_timeout_seconds: float = Field(default=10, alias="SMTP_TIMEOUT_SECONDS", ge=2, le=30)
    smtp_send_deadline_seconds: float = Field(default=30, alias="SMTP_SEND_DEADLINE_SECONDS", ge=5, le=120)
    smtp_term_grace_seconds: float = Field(default=1, alias="SMTP_TERM_GRACE_SECONDS", ge=0.1, le=10)
    smtp_reap_timeout_seconds: float = Field(default=2, alias="SMTP_REAP_TIMEOUT_SECONDS", ge=0.5, le=10)

    # --- Manutenção (P5): expurgo global de retenção no PostgreSQL ---
    # Lotes pequenos com FOR UPDATE SKIP LOCKED, transações próprias e curtas (doc 20).
    maintenance_batch_size: int = Field(default=200, alias="MAINTENANCE_BATCH_SIZE", ge=1, le=1_000)
    maintenance_max_batches_per_run: int = Field(default=50, alias="MAINTENANCE_MAX_BATCHES_PER_RUN", ge=1, le=10_000)
    maintenance_lock_timeout_ms: int = Field(default=200, alias="MAINTENANCE_LOCK_TIMEOUT_MS", ge=10, le=5_000)
    maintenance_statement_timeout_ms: int = Field(
        default=5_000, alias="MAINTENANCE_STATEMENT_TIMEOUT_MS", ge=100, le=60_000
    )
    # Execução oportunista (no máximo uma por intervalo e por processo; só em STORAGE=postgres).
    maintenance_opportunistic_enabled: bool = Field(default=True, alias="MAINTENANCE_OPPORTUNISTIC_ENABLED")
    maintenance_interval_seconds: int = Field(default=300, alias="MAINTENANCE_INTERVAL_SECONDS", ge=10, le=86_400)
    maintenance_opportunistic_max_batches: int = Field(
        default=4, alias="MAINTENANCE_OPPORTUNISTIC_MAX_BATCHES", ge=1, le=100
    )

    @field_validator("deadlines_timezone")
    @classmethod
    def _valid_timezone(cls, v: str) -> str:
        from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

        value = (v or "").strip()
        try:
            ZoneInfo(value)
        except (ZoneInfoNotFoundError, ValueError):
            raise ValueError(
                f"DEADLINES_TIMEZONE inválido: {v!r} (use um nome IANA, ex.: America/Sao_Paulo)."
            ) from None
        return value

    @field_validator("offices_enabled", mode="before")
    @classmethod
    def _empty_offices_enabled(cls, v: object) -> object:
        return None if isinstance(v, str) and v.strip() == "" else v

    @property
    def offices_active(self) -> bool:
        return self.auth_enabled if self.offices_enabled is None else self.offices_enabled

    # --- IP do cliente via intermediário confiável (Etapa 6.1; DESATIVADO por padrão) ---
    # Quando definido, o backend aceita `X-PrazoAI-Client-IP` SOMENTE se a requisição trouxer
    # `X-PrazoAI-Proxy-Secret` igual a este segredo (comparação em tempo constante). O
    # `X-Forwarded-For` continua ignorado. Mínimo de 32 bytes. Nunca exponha ao navegador.
    trusted_proxy_secret: SecretStr | None = Field(default=None, alias="TRUSTED_PROXY_SECRET")

    @field_validator("trusted_proxy_secret")
    @classmethod
    def _valid_proxy_secret(cls, v: SecretStr | None) -> SecretStr | None:
        if v is None:
            return None
        raw = v.get_secret_value().strip()
        if raw == "":
            return None
        if len(raw.encode("utf-8")) < 32:
            raise ValueError("TRUSTED_PROXY_SECRET deve ter pelo menos 32 bytes.")
        return SecretStr(raw)

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

    @field_validator("storage")
    @classmethod
    def _valid_storage(cls, v: str) -> str:
        value = (v or "memory").strip().lower()
        if value in {"memory", "postgres"}:
            return value
        if value == "auth-postgres":
            raise ValueError(
                "STORAGE='auth-postgres' foi removido na P4: use 'postgres' (autenticação e domínio no banco)."
            )
        raise ValueError(f"STORAGE inválido: {v!r}. Use 'memory' ou 'postgres'.")

    @field_validator("database_url", mode="before")
    @classmethod
    def _empty_database_url(cls, v: object) -> object:
        if isinstance(v, str) and not v.strip():
            return None  # variável vazia = não configurada (sem validar o conteúdo aqui)
        return v

    @model_validator(mode="after")
    def _consistent_email(self) -> Settings:
        if self.email_transport not in {"disabled", "smtp"}:
            raise ValueError("EMAIL_TRANSPORT inválido: use 'disabled' ou 'smtp'.")
        if self.email_transport == "smtp":
            from app.email.config import EmailConfig, EmailConfigError

            try:
                EmailConfig.from_settings(self)            # valida forma; plataforma é checada no transporte
            except EmailConfigError as exc:
                raise ValueError(str(exc)) from None
        return self

    @model_validator(mode="after")
    def _consistent_storage(self) -> Settings:
        if self.storage == "postgres":
            if self.auth_storage_explicit:
                raise ValueError(
                    "AUTH_STORAGE (configuração antiga, só 'memory') conflita com STORAGE='postgres': "
                    "remova AUTH_STORAGE."
                )
            if self.environment not in {"development", "test"}:
                raise ValueError("STORAGE='postgres' só é aceito em ENVIRONMENT=development ou test nesta fase.")
        return self

    @property
    def storage_durable(self) -> bool:
        """Estado do BACKEND (autenticação e domínio) sobrevive a reinícios? Não inclui as sessões do BFF."""
        return self.storage == "postgres"

    @model_validator(mode="after")
    def _consistent_timeouts(self) -> Settings:
        if self.database_statement_timeout_ms < self.database_lock_timeout_ms:
            raise ValueError(
                "DATABASE_STATEMENT_TIMEOUT_MS deve ser maior ou igual a DATABASE_LOCK_TIMEOUT_MS "
                "(senão uma espera por bloqueio seria interrompida como consulta lenta)."
            )
        return self

    @property
    def auth_storage_explicit(self) -> bool:
        """AUTH_STORAGE definido explicitamente (configuração antiga, aceita só como 'memory')."""
        return "auth_storage" in self.model_fields_set

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
