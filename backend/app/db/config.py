"""Configuração do banco a partir das Settings, com validação SEM expor credenciais.

Regras:
- driver aceito: `postgresql` ou `postgresql+psycopg` (normalizado para `postgresql+psycopg`);
- a URL precisa nomear um banco;
- a URL não pode definir `options` (timeouts e esquema são fixados pela aplicação);
- a URL não pode redirecionar a conexão por parâmetros ambíguos (`service`, `hostaddr`, `dbname`)
  nem listar vários hosts; `host`/`port` na query são aceitos (socket local) e considerados na
  identificação do destino;
- mensagens de erro e descrições nunca incluem usuário, senha nem a URL completa.
"""
from __future__ import annotations

from dataclasses import dataclass

from sqlalchemy.engine import URL, make_url
from sqlalchemy.exc import ArgumentError

from app.core.config import Settings

#: Esquema EXPLÍCITO de todas as tabelas do projeto (inclusive a de versões do Alembic).
SCHEMA = "prazoai"

_DRIVERS = {"postgresql", "postgresql+psycopg"}
_FORBIDDEN_QUERY_KEYS = {"options", "service", "hostaddr", "dbname"}


class DatabaseConfigError(ValueError):
    """Configuração de banco inválida (mensagem segura, sem credenciais)."""


@dataclass(frozen=True)
class DatabaseConfig:
    url: URL
    pool_size: int
    max_overflow: int
    pool_timeout_seconds: int
    connect_timeout_seconds: int
    lock_timeout_ms: int
    statement_timeout_ms: int

    def describe(self) -> str:
        return safe_target(self.url)

    def __repr__(self) -> str:  # nunca imprime a URL com credenciais
        return f"DatabaseConfig(target={self.describe()!r}, pool_size={self.pool_size})"


def parse_database_url(raw: str, *, var_name: str = "DATABASE_URL") -> URL:
    """Valida e normaliza a URL. Erros não carregam o valor recebido (nem encadeiam a exceção)."""
    if not raw or not raw.strip():
        raise DatabaseConfigError(f"{var_name} não definida.")
    try:
        url = make_url(raw.strip())
    except (ArgumentError, ValueError):
        raise DatabaseConfigError(f"{var_name} inválida: formato de URL não reconhecido.") from None
    if url.drivername not in _DRIVERS:
        raise DatabaseConfigError(
            f"{var_name} deve usar o driver 'postgresql+psycopg' (recebido: {url.drivername!r})."
        )
    if not url.database:
        raise DatabaseConfigError(f"{var_name} precisa indicar o nome do banco.")
    bad = sorted(k for k in url.query if k.lower() in _FORBIDDEN_QUERY_KEYS)
    if bad:
        raise DatabaseConfigError(
            f"{var_name} não pode definir {bad}: timeouts, esquema e destino são definidos de forma explícita."
        )
    for key in ("host", "port"):
        value = url.query.get(key)
        if isinstance(value, tuple) or (isinstance(value, str) and "," in value):
            raise DatabaseConfigError(f"{var_name} não pode listar vários valores em {key!r}.")
    if url.host and "," in url.host:
        raise DatabaseConfigError(f"{var_name} não pode listar vários hosts.")
    return url.set(drivername="postgresql+psycopg")


def effective_host_port(url: URL) -> tuple[str, int]:
    """Host e porta EFETIVOS, como o driver usará: parâmetros da query têm precedência."""
    q_host = url.query.get("host")
    q_port = url.query.get("port")
    host = q_host if isinstance(q_host, str) and q_host else (url.host or "")
    port = int(q_port) if isinstance(q_port, str) and q_port.isdigit() else int(url.port or 5432)
    return host, port


def safe_target(url: URL) -> str:
    """Destino legível sem credenciais: host:porta/banco (socket local quando o host é um caminho)."""
    host, port = effective_host_port(url)
    if not host or host.startswith("/"):
        host = "socket-local"
    return f"{host}:{port}/{url.database}"


def database_config_from(settings: Settings, *, url: URL | None = None) -> DatabaseConfig:
    if url is None:
        if settings.database_url is None:
            raise DatabaseConfigError("DATABASE_URL não definida.")
        url = parse_database_url(settings.database_url.get_secret_value())
    return DatabaseConfig(
        url=url,
        pool_size=settings.database_pool_size,
        max_overflow=settings.database_max_overflow,
        pool_timeout_seconds=settings.database_pool_timeout_seconds,
        connect_timeout_seconds=settings.database_connect_timeout_seconds,
        lock_timeout_ms=settings.database_lock_timeout_ms,
        statement_timeout_ms=settings.database_statement_timeout_ms,
    )
