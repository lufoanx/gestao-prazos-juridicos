"""Configuração do banco a partir das Settings, com validação SEM expor credenciais.

Regras:
- driver aceito: `postgresql` ou `postgresql+psycopg` (normalizado para `postgresql+psycopg`);
- a URL precisa nomear um banco;
- a URL não pode definir `options` (timeouts e esquema são fixados pela aplicação);
- a URL não pode redirecionar a conexão por parâmetros ambíguos (`service`, `hostaddr`, `dbname`)
  nem listar vários hosts; `host`/`port` na query são aceitos (socket local) e considerados na
  identificação do destino;
- mensagens de erro e descrições nunca incluem usuário, senha nem a URL completa.

DESTINO EFETIVO (correção da auditoria da P1): a libpq completa parâmetros ausentes com variáveis de
ambiente (PGHOST, PGPORT, PGDATABASE…) e pode redirecionar a conexão (PGHOSTADDR, PGSERVICE com
arquivo de serviço). Política adotada, sem alterar o ambiente do processo:
1. RECUSAR antes de conectar se PGHOSTADDR, PGSERVICE ou PGSERVICEFILE estiverem definidas;
2. EXIGIR host explícito (na URL ou em `?host=` para socket) — host ausente NÃO é "local";
3. VALIDAR portas (1–65535) da URL e da query; recusar host/porta definidos nos dois lugares;
4. passar ao driver `host`, `port` e `dbname` SEMPRE explícitos (ConnectionTarget), de modo que
   PGHOST/PGPORT/PGDATABASE herdadas não tenham efeito.
"""
from __future__ import annotations

import os
import re
from collections.abc import Mapping
from dataclasses import dataclass

from sqlalchemy.engine import URL, make_url
from sqlalchemy.exc import ArgumentError

from app.core.config import Settings

#: Esquema EXPLÍCITO de todas as tabelas do projeto (inclusive a de versões do Alembic).
SCHEMA = "prazoai"

_DRIVERS = {"postgresql", "postgresql+psycopg"}
_FORBIDDEN_QUERY_KEYS = {"options", "service", "hostaddr", "dbname"}


#: Variáveis libpq que redirecionam a conexão mesmo com host explícito: recusadas.
AMBIGUOUS_LIBPQ_ENV = ("PGHOSTADDR", "PGSERVICE", "PGSERVICEFILE")
_PORT_RE = re.compile(r"^[0-9]{1,5}$")


class DatabaseConfigError(ValueError):
    """Configuração de banco inválida (mensagem segura, sem credenciais)."""


@dataclass(frozen=True)
class ConnectionTarget:
    """Destino EFETIVO entregue ao driver: host (nome, IP ou diretório de socket), porta e banco."""

    host: str
    port: int
    database: str

    @property
    def is_socket(self) -> bool:
        return self.host.startswith("/")

    def describe(self) -> str:
        host = "socket-local" if self.is_socket else self.host
        return f"{host}:{self.port}/{self.database}"


@dataclass(frozen=True)
class DatabaseConfig:
    url: URL
    target: ConnectionTarget
    pool_size: int
    max_overflow: int
    pool_timeout_seconds: int
    connect_timeout_seconds: int
    lock_timeout_ms: int
    statement_timeout_ms: int

    def describe(self) -> str:
        return self.target.describe()

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


def _valid_port(raw: object, *, where: str, var_name: str) -> int:
    text_ = str(raw).strip()
    if not _PORT_RE.fullmatch(text_) or not 1 <= int(text_) <= 65535:
        raise DatabaseConfigError(f"{var_name}: porta inválida em {where} (use 1 a 65535).")
    return int(text_)


def resolve_target(
    url: URL, *, env: Mapping[str, str] | None = None, var_name: str = "DATABASE_URL",
) -> ConnectionTarget:
    """Destino EFETIVO e inequívoco. Recusa (antes de qualquer conexão) o que o deixaria ambíguo."""
    environ = os.environ if env is None else env
    present = [v for v in AMBIGUOUS_LIBPQ_ENV if environ.get(v)]
    if present:
        raise DatabaseConfigError(
            f"Variáveis libpq {present} definidas no ambiente: o destino efetivo ficaria ambíguo. "
            "Remova-as antes de usar o banco."
        )
    q_host = url.query.get("host")
    q_port = url.query.get("port")
    if url.host and q_host:
        raise DatabaseConfigError(f"{var_name} define o host na URL e na query: ambíguo.")
    if url.port is not None and q_port is not None:
        raise DatabaseConfigError(f"{var_name} define a porta na URL e na query: ambíguo.")
    host = url.host or (q_host if isinstance(q_host, str) else "")
    if not host:
        raise DatabaseConfigError(
            f"{var_name} precisa indicar o host explicitamente (sem ele, o driver usaria PGHOST ou o socket padrão)."
        )
    if url.port is not None:
        port = _valid_port(url.port, where="a URL", var_name=var_name)
    elif q_port is not None:
        port = _valid_port(q_port, where="a query", var_name=var_name)
    else:
        port = 5432          # explícito: PGPORT herdada não tem efeito, porque a porta é sempre passada
    return ConnectionTarget(host=host, port=port, database=str(url.database))


def safe_target(url: URL) -> str:
    """Destino legível sem credenciais (resolvido sem consultar o ambiente)."""
    try:
        return resolve_target(url, env={}).describe()
    except DatabaseConfigError:
        return f"(destino ambíguo)/{url.database}"


def database_config_from(
    settings: Settings, *, url: URL | None = None, env: Mapping[str, str] | None = None,
    var_name: str = "DATABASE_URL",
) -> DatabaseConfig:
    if url is None:
        if settings.database_url is None:
            raise DatabaseConfigError("DATABASE_URL não definida.")
        url = parse_database_url(settings.database_url.get_secret_value())
    return DatabaseConfig(
        url=url,
        target=resolve_target(url, env=env, var_name=var_name),
        pool_size=settings.database_pool_size,
        max_overflow=settings.database_max_overflow,
        pool_timeout_seconds=settings.database_pool_timeout_seconds,
        connect_timeout_seconds=settings.database_connect_timeout_seconds,
        lock_timeout_ms=settings.database_lock_timeout_ms,
        statement_timeout_ms=settings.database_statement_timeout_ms,
    )
