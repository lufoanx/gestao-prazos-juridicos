"""Proteções do banco de TESTE (doc 15, §5.7) — aplicadas ANTES de qualquer escrita.

Ordem:
1. autorização SEM CONECTAR, sobre o destino EFETIVO (app/db/config.resolve_target): variáveis libpq
   que redirecionariam a conexão são recusadas, o host precisa ser explícito, as portas são validadas,
   e host/porta/banco são entregues explicitamente ao driver;
2. conexão e verificações SOMENTE LEITURA: banco atual e destino efetivo informado pela libpq
   (host, hostaddr, porta, banco) precisam bater com o autorizado; marcador e tabelas;
3. só então escritas (marcador em banco vazio; limpeza das tabelas do projeto com RESTRICT).
Nenhuma mensagem inclui usuário, senha ou a URL completa. O ambiente do processo não é alterado.
"""
from __future__ import annotations

import re
from collections.abc import Callable, Mapping
from dataclasses import dataclass

from sqlalchemy import Connection, Engine, MetaData, text
from sqlalchemy.engine import URL

from app.core.config import Settings
from app.db.config import (
    SCHEMA,
    ConnectionTarget,
    DatabaseConfig,
    DatabaseConfigError,
    database_config_from,
    parse_database_url,
    resolve_target,
)

TEST_DB_NAME = re.compile(r"^prazoai_test(_[a-z0-9_]+)?$")
LOCAL_NAMES = {"localhost"}
LOOPBACK_ADDRS = {"127.0.0.1", "::1"}
CI_SERVICE_HOSTS = {"postgres"}
MARKER_TABLE = "prazoai_test_marker"


class UnauthorizedTestDatabase(RuntimeError):
    """O banco indicado não pode ser usado (e limpo) pelos testes."""


@dataclass(frozen=True)
class Target:
    """Destino comparável: hosts locais (localhost, loopback, socket) viram 'local'."""

    host: str
    port: int
    database: str


@dataclass(frozen=True)
class AuthorizedTestDatabase:
    url: URL
    target: ConnectionTarget


def _comparable(target: ConnectionTarget) -> Target:
    host = target.host.strip().lower().strip("[]")
    if target.is_socket or host in LOCAL_NAMES or host in LOOPBACK_ADDRS:
        host = "local"
    return Target(host=host, port=target.port, database=target.database)


def normalize_target(url: URL, env: Mapping[str, str] | None = None) -> Target:
    return _comparable(resolve_target(url, env={} if env is None else env))


def authorize_test_database(
    test_raw: str | None, app_raw: str | None, *, environment: str, ci: bool, env: Mapping[str, str],
) -> AuthorizedTestDatabase:
    """Valida TEST_DATABASE_URL sem conectar, sobre o destino que o driver realmente usará."""
    if not test_raw:
        raise UnauthorizedTestDatabase("TEST_DATABASE_URL não definida.")
    if environment != "test":
        raise UnauthorizedTestDatabase(f"ENVIRONMENT precisa ser 'test' (atual: {environment!r}).")
    try:
        url = parse_database_url(test_raw, var_name="TEST_DATABASE_URL")
        target = resolve_target(url, env=env, var_name="TEST_DATABASE_URL")
    except DatabaseConfigError as exc:
        raise UnauthorizedTestDatabase(str(exc)) from None
    comparable = _comparable(target)
    if not TEST_DB_NAME.fullmatch(target.database):
        raise UnauthorizedTestDatabase(
            f"Nome de banco não autorizado para testes: {target.database!r} "
            "(use prazoai_test ou prazoai_test_<sufixo>)."
        )
    if comparable.host != "local" and not (ci and comparable.host in CI_SERVICE_HOSTS):
        raise UnauthorizedTestDatabase(
            f"Host não autorizado para testes: {comparable.host!r} (só local; serviço do CI apenas com CI=true)."
        )
    if app_raw:
        try:
            app_target = _comparable(resolve_target(parse_database_url(app_raw), env=env))
        except DatabaseConfigError:
            raise UnauthorizedTestDatabase(
                "DATABASE_URL inválida ou ambígua: não é possível garantir que TEST_DATABASE_URL "
                "aponta para outro banco."
            ) from None
        if app_target == comparable:
            raise UnauthorizedTestDatabase("TEST_DATABASE_URL aponta para o MESMO destino que DATABASE_URL.")
    return AuthorizedTestDatabase(url=url, target=target)


def config_for_test_database(auth: AuthorizedTestDatabase, env: Mapping[str, str]) -> DatabaseConfig:
    return database_config_from(Settings(_env_file=None), url=auth.url, env=env, var_name="TEST_DATABASE_URL")


def verify_effective_destination(conn: Connection, target: ConnectionTarget, *, ci: bool = False) -> None:
    """Confere, SEM escrever, o destino que a libpq realmente usou nesta conexão."""
    info = conn.connection.dbapi_connection.info  # type: ignore[union-attr]
    if info.dbname != target.database or int(info.port) != target.port or info.host != target.host:
        raise UnauthorizedTestDatabase("A conexão efetiva não corresponde ao destino autorizado.")
    hostaddr = info.hostaddr or ""
    if target.is_socket:
        if hostaddr:
            raise UnauthorizedTestDatabase("Conexão por socket com endereço de rede inesperado.")
    elif target.host.lower() in LOCAL_NAMES or target.host in LOOPBACK_ADDRS:
        if hostaddr not in LOOPBACK_ADDRS:
            raise UnauthorizedTestDatabase("Host local resolvido para um endereço que não é de loopback.")
    elif not (ci and target.host in CI_SERVICE_HOSTS):
        raise UnauthorizedTestDatabase("Destino efetivo não autorizado.")


def verify_and_prepare(conn: Connection, expected: Target) -> str:
    """Verificações somente leitura; depois, se o banco estiver vazio, cria o marcador.

    Retorna 'marcado' (banco novo preparado) ou 'reconhecido' (marcador já existia).
    """
    current = conn.execute(text("SELECT current_database()")).scalar_one()
    if current != expected.database:
        raise UnauthorizedTestDatabase(f"Conectado a {current!r}, esperado {expected.database!r}.")
    tables = {
        (r[0], r[1]) for r in conn.execute(text(
            "SELECT n.nspname, c.relname FROM pg_catalog.pg_class c "
            "JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace "
            "WHERE c.relkind IN ('r', 'p') "
            "AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg_toast%'"
        ))
    }
    has_marker = (SCHEMA, MARKER_TABLE) in tables
    if not has_marker:
        if tables:
            raise UnauthorizedTestDatabase(
                "O banco já tem tabelas e não tem o marcador de teste: recusado (pode ser um banco real)."
            )
        conn.execute(text(f'CREATE SCHEMA IF NOT EXISTS "{SCHEMA}"'))
        conn.execute(text(
            f'CREATE TABLE "{SCHEMA}"."{MARKER_TABLE}" (created_at timestamptz NOT NULL, note text NOT NULL)'
        ))
        conn.execute(text(
            f'INSERT INTO "{SCHEMA}"."{MARKER_TABLE}" VALUES (clock_timestamp(), :n)'
        ), {"n": "Banco descartável dos testes do PrazoAI"})
        return "marcado"
    foreign = sorted(f"{s}.{t}" for s, t in tables if s != SCHEMA)
    if foreign:
        raise UnauthorizedTestDatabase(f"Tabelas fora do esquema do projeto: {foreign[:5]} — recusado.")
    return "reconhecido"


def open_test_engine(
    *, test_raw: str | None, app_raw: str | None, environment: str, ci: bool, env: Mapping[str, str],
    engine_factory: Callable[..., Engine],
) -> tuple[Engine, AuthorizedTestDatabase]:
    """Autoriza (sem conectar) → cria o engine → verifica destino e conteúdo (só leitura) → marcador.

    Em qualquer recusa da etapa 1, `engine_factory` nem é chamada: nenhuma conexão, nenhuma escrita.
    """
    auth = authorize_test_database(test_raw, app_raw, environment=environment, ci=ci, env=env)
    cfg = config_for_test_database(auth, env)
    engine = engine_factory(cfg, application_name="prazoai-tests")
    try:
        with engine.begin() as conn:
            verify_effective_destination(conn, auth.target, ci=ci)
            verify_and_prepare(conn, _comparable(auth.target))
    except BaseException:
        engine.dispose()
        raise
    return engine, auth


def truncate_statement(metadata: MetaData) -> str | None:
    """TRUNCATE só das tabelas do projeto, com nomes qualificados e RESTRICT (nunca CASCADE)."""
    names = [f'"{SCHEMA}"."{t.name}"' for t in metadata.sorted_tables if t.schema == SCHEMA]
    if not names:
        return None
    return f"TRUNCATE TABLE {', '.join(names)} RESTRICT"
