"""Configuração da aplicação e validação de variáveis de ambiente.

Nenhum segredo fica no código. Valores vêm do ambiente (.env em desenvolvimento,
variáveis do provedor em produção). Ambientes:
- development/test: memória (padrão) ou PostgreSQL; nunca para contas reais;
- staging (homologação) e production: só iniciam com TODOS os requisitos de implantação
  (`ensure_hosted_requirements`): PostgreSQL com TLS, segredos, origem pública, proxy confiável e
  recuperação de senha por SMTP autenticado. Ver docs/backend/27-implantacao-homologacao-producao.md.
"""
from __future__ import annotations

from collections.abc import Mapping
from functools import lru_cache
from typing import Literal

from pydantic import Field, SecretStr, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

#: Ambientes HOSPEDADOS: homologação (staging) e produção. Mesmas exigências; contas reais só em production.
HOSTED_ENVIRONMENTS = frozenset({"staging", "production"})
#: Modos TLS aceitos para o PostgreSQL em ambiente hospedado.
HOSTED_DB_SSLMODES = frozenset({"require", "verify-ca", "verify-full"})
_LOOPBACK = frozenset({"localhost", "127.0.0.1", "::1"})


class HostedConfigError(RuntimeError):
    """Ambiente hospedado (staging/production) com requisito ausente ou inseguro.

    Substitui o antigo bloqueio incondicional de produção (doc 15, §5.6): em vez de recusar sempre,
    a aplicação recusa iniciar enquanto QUALQUER requisito de implantação faltar. A mensagem lista
    todos os problemas de uma vez e NUNCA inclui valores (segredos, URLs com credenciais).
    """

    def __init__(self, environment: str, problems: list[str]) -> None:
        self.problems = tuple(problems)
        super().__init__(
            f"ENVIRONMENT={environment} recusado: {len(problems)} requisito(s) de implantação ausente(s) ou "
            "inseguro(s): " + " | ".join(problems)
        )


def _is_loopback_host(host: str | None) -> bool:
    import ipaddress

    if not host:
        return False
    if host.lower() in _LOOPBACK:
        return True
    try:
        return ipaddress.ip_address(host.strip("[]")).is_loopback
    except ValueError:
        return False


def hosted_config_problems(settings: Settings, env: Mapping[str, str] | None = None) -> list[str]:
    """Requisitos de homologação/produção não atendidos (lista vazia = pronto para iniciar).

    Só a FORMA da configuração é verificada aqui; conectividade (banco, SMTP) é conferida no startup
    (esquema do banco) e nas verificações de disponibilidade.
    """
    import os
    from urllib.parse import urlsplit

    environ = os.environ if env is None else env
    problems: list[str] = []
    # Módulos do produto: contas, escritórios e domínio precisam estar ligados.
    if not settings.auth_enabled:
        problems.append("AUTH_ENABLED deve ser true")
    if not settings.offices_active:
        problems.append("OFFICES_ENABLED não pode ser false")
    # Entrar com Google: em ambiente hospedado só o provedor real (sem JWKS/emissor substituídos).
    if settings.google_jwks_url or settings.google_issuer:
        problems.append("GOOGLE_JWKS_URL/GOOGLE_ISSUER são só para testes; remova-os")
    # Persistência.
    if settings.storage != "postgres":
        problems.append("STORAGE deve ser postgres (memória perde contas ao reiniciar)")
    if settings.auth_storage_explicit:
        problems.append("remova AUTH_STORAGE (configuração antiga)")
    if settings.database_url is None:
        problems.append("DATABASE_URL é obrigatória")
    else:
        from sqlalchemy.engine import make_url

        try:
            sslmode = make_url(settings.database_url.get_secret_value().strip()).query.get("sslmode")
        except Exception:  # noqa: BLE001 - a mensagem não pode conter o valor
            sslmode = None
            problems.append("DATABASE_URL inválida")
        else:
            if sslmode not in HOSTED_DB_SSLMODES:
                problems.append("DATABASE_URL deve definir sslmode=require|verify-ca|verify-full")
    # Segredos.
    if settings.auth_jwt_secret is None:
        problems.append("AUTH_JWT_SECRET é obrigatório")
    if settings.trusted_proxy_secret is None:
        problems.append("TRUSTED_PROXY_SECRET é obrigatório (IP real do cliente nos limites de taxa)")
    # Origem pública e CORS.
    origin = (settings.public_app_origin or "").strip()
    parts = urlsplit(origin) if origin else None
    if parts is None:
        problems.append("PUBLIC_APP_ORIGIN é obrigatória")
    elif parts.scheme != "https" or not parts.hostname or _is_loopback_host(parts.hostname) \
            or parts.path not in ("", "/") or parts.query or parts.fragment or parts.username:
        problems.append("PUBLIC_APP_ORIGIN deve ser uma origem https pública (só esquema, host e porta)")
    if settings.cors_has_wildcard:
        problems.append("CORS_ORIGINS não pode conter '*'")
    normalized_origin = origin.rstrip("/")
    for item in settings.cors_origin_list:
        if item.rstrip("/") != normalized_origin:
            problems.append(
                "CORS_ORIGINS só pode conter PUBLIC_APP_ORIGIN (ou ficar vazia: o navegador fala só com o BFF)"
            )
            break
    # Recuperação de senha por e-mail transacional.
    if settings.email_transport != "smtp":
        problems.append("EMAIL_TRANSPORT deve ser smtp (recuperação de senha obrigatória)")
    else:
        if (settings.smtp_security or "").strip().lower() not in {"tls", "starttls"}:
            problems.append("SMTP_SECURITY deve ser tls ou starttls")
        if not settings.smtp_username or settings.smtp_password is None:
            problems.append("SMTP_USERNAME e SMTP_PASSWORD são obrigatórios (provedor transacional autenticado)")
        if settings.smtp_allow_insecure_local:
            problems.append("SMTP_ALLOW_INSECURE_LOCAL deve ser false")
        if _is_loopback_host((settings.smtp_host or "").strip()):
            problems.append("SMTP_HOST não pode ser loopback (capturador local)")
    # Arquivos de intimação: Azure Blob privado, por HTTPS, nunca o emulador local.
    if settings.file_storage != "azure_blob":
        problems.append("FILE_STORAGE deve ser azure_blob (PDFs das intimações)")
    elif settings.azure_storage_connection_string is not None:
        conn = settings.azure_storage_connection_string.get_secret_value()
        azure = {k.strip().lower(): v.strip() for k, _, v in (p.partition("=") for p in conn.split(";") if p.strip())}
        if azure.get("defaultendpointsprotocol", "").lower() != "https" or "usedevelopmentstorage" in azure \
                or azure.get("accountname", "").lower() == "devstoreaccount1" \
                or any(k.endswith("endpoint") and not azure[k].lower().startswith("https://") for k in azure):
            problems.append("AZURE_STORAGE_CONNECTION_STRING deve usar https e uma conta real (não o emulador)")
    # Operação.
    if settings.log_level.strip().upper() in {"DEBUG", "NOTSET"}:
        problems.append("LOG_LEVEL não pode ser DEBUG")
    workers = (environ.get("WEB_CONCURRENCY") or "1").strip()
    if workers != "1":
        problems.append(
            "WEB_CONCURRENCY deve ser 1: limites de taxa e fila de e-mail são por processo "
            "(escale o BFF, não o backend)"
        )
    return problems


def ensure_hosted_requirements(settings: Settings, env: Mapping[str, str] | None = None) -> None:
    """Recusa iniciar em staging/production se faltar requisito. Sem efeito em development/test."""
    if not settings.is_hosted:
        return
    problems = hosted_config_problems(settings, env)
    if problems:
        raise HostedConfigError(settings.environment, problems)


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
    #   "postgres" — autenticação E domínio no PostgreSQL (obrigatório em staging/production).
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
    # E2 (doc 21): limite NOVO por IP no pedido de recuperação, aplicado ANTES do limite por e-mail.
    auth_forgot_ip_max_requests: int = Field(default=10, alias="AUTH_FORGOT_IP_MAX_REQUESTS", ge=1, le=1000)
    auth_forgot_ip_window_seconds: int = Field(
        default=900, alias="AUTH_FORGOT_IP_WINDOW_SECONDS", ge=10, le=24 * 3600
    )
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

    # --- Entrar com Google (opcional; vazio = desligado) ---
    # O backend verifica o ID token (assinatura, emissor, público, validade, nonce, e-mail verificado).
    google_client_id: str | None = Field(default=None, alias="GOOGLE_CLIENT_ID", max_length=256)
    # Só para testes (provedor simulado): recusados em ambiente hospedado.
    google_jwks_url: str | None = Field(default=None, alias="GOOGLE_JWKS_URL", max_length=2048)
    google_issuer: str | None = Field(default=None, alias="GOOGLE_ISSUER", max_length=2048)
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
    # Padrão `disabled`: nenhum e-mail é enviado e a recuperação de senha fica INDISPONÍVEL
    # (`status` → available=false; `forgot-password` → 503). Com `smtp`, a E2 liga o transporte à
    # recuperação pelo RecoveryDispatcher (fila em memória, um worker; app/recovery).
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

    # --- RecoveryDispatcher (E2 do doc 21, §4.5–§4.8): fila em memória, limitada, um worker ---
    recovery_queue_max: int = Field(default=100, alias="RECOVERY_QUEUE_MAX", ge=10, le=10_000)
    recovery_queue_max_wait_seconds: float = Field(
        default=60, alias="RECOVERY_QUEUE_MAX_WAIT_SECONDS", ge=10, le=600
    )
    recovery_shutdown_grace_seconds: float = Field(
        default=5, alias="RECOVERY_SHUTDOWN_GRACE_SECONDS", ge=1, le=60
    )
    recovery_db_lock_timeout_ms: int = Field(default=1000, alias="RECOVERY_DB_LOCK_TIMEOUT_MS", ge=100, le=30_000)
    recovery_db_statement_timeout_ms: int = Field(
        default=3000, alias="RECOVERY_DB_STATEMENT_TIMEOUT_MS", ge=500, le=60_000
    )

    # --- Arquivos de intimação (PDF) ---
    # disabled (padrão): upload/download respondem 503 `file_storage_unavailable` (registro só de metadados).
    # azure_blob: bytes no Azure Blob Storage (container PRIVADO); metadados e vínculo no PostgreSQL
    # (exige STORAGE=postgres). Obrigatório em staging/production. Ver docs/backend/28-pdf-intimacoes.md.
    file_storage: str = Field(default="disabled", alias="FILE_STORAGE")
    # Segredo (somente servidor). Em ambiente hospedado: DefaultEndpointsProtocol=https; nunca o emulador.
    azure_storage_connection_string: SecretStr | None = Field(default=None, alias="AZURE_STORAGE_CONNECTION_STRING")
    azure_storage_container: str = Field(default="prazoai-intimacoes", alias="AZURE_STORAGE_CONTAINER")
    file_storage_timeout_seconds: int = Field(default=20, alias="FILE_STORAGE_TIMEOUT_SECONDS", ge=2, le=120)
    # Uma reserva de upload não concluída vira limpeza (apaga o blob, se existir) depois deste prazo.
    file_upload_reservation_seconds: int = Field(
        default=3600, alias="FILE_UPLOAD_RESERVATION_SECONDS", ge=60, le=24 * 3600
    )

    @field_validator("azure_storage_container")
    @classmethod
    def _valid_container(cls, v: str) -> str:
        import re

        value = (v or "").strip()
        if not re.fullmatch(r"[a-z0-9](?!.*--)[a-z0-9-]{1,61}[a-z0-9]", value):
            raise ValueError("AZURE_STORAGE_CONTAINER inválido (3–63: minúsculas, dígitos e hífen).")
        return value

    @field_validator("azure_storage_connection_string", mode="before")
    @classmethod
    def _empty_azure(cls, v: object) -> object:
        return None if isinstance(v, str) and not v.strip() else v

    @model_validator(mode="after")
    def _consistent_files(self) -> Settings:
        if self.file_storage not in {"disabled", "azure_blob"}:
            raise ValueError("FILE_STORAGE inválido: use 'disabled' ou 'azure_blob'.")
        if self.file_storage == "azure_blob":
            if self.storage != "postgres":
                raise ValueError("FILE_STORAGE=azure_blob exige STORAGE=postgres (metadados e vínculo no banco).")
            if self.azure_storage_connection_string is None:
                raise ValueError("FILE_STORAGE=azure_blob exige AZURE_STORAGE_CONNECTION_STRING.")
        return self

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
        if self.recovery_db_lock_timeout_ms > self.recovery_db_statement_timeout_ms:
            raise ValueError("RECOVERY_DB_LOCK_TIMEOUT_MS não pode exceder RECOVERY_DB_STATEMENT_TIMEOUT_MS.")
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
    def is_hosted(self) -> bool:
        """Homologação ou produção: exigências de implantação, sem documentação interativa."""
        return self.environment in HOSTED_ENVIRONMENTS

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
