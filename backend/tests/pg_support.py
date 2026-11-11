"""Proteções do banco de TESTE (doc 15, §5.7) — aplicadas ANTES de qualquer escrita.

Ordem: (1) autorização pura (sem conectar) → (2) conexão e verificações SOMENTE LEITURA →
(3) só então escritas (marcador em banco vazio; limpeza das tabelas do projeto).
Nenhuma mensagem inclui usuário, senha ou a URL completa.
"""
from __future__ import annotations

import re
from dataclasses import dataclass

from sqlalchemy import Connection, MetaData, text
from sqlalchemy.engine import URL

from app.db.config import SCHEMA, DatabaseConfigError, effective_host_port, parse_database_url

TEST_DB_NAME = re.compile(r"^prazoai_test(_[a-z0-9_]+)?$")
LOCAL_HOSTS = {"localhost", "127.0.0.1", "::1", "local"}
CI_SERVICE_HOSTS = {"postgres"}
MARKER_TABLE = "prazoai_test_marker"
ALEMBIC_TABLE = "alembic_version"


class UnauthorizedTestDatabase(RuntimeError):
    """O banco indicado não pode ser usado (e limpo) pelos testes."""


@dataclass(frozen=True)
class Target:
    host: str
    port: int
    database: str


def normalize_target(url: URL) -> Target:
    """Destino EFETIVO comparável (host/porta da query têm precedência, como no driver).

    Hosts locais (nomes, IPs de loopback e caminhos de socket) viram 'local'.
    """
    host, port = effective_host_port(url)
    host = host.strip().lower().strip("[]")
    if not host or host in LOCAL_HOSTS or host.startswith("/"):
        host = "local"
    return Target(host=host, port=port, database=(url.database or "").strip())


def authorize_test_database(test_raw: str | None, app_raw: str | None, *, environment: str, ci: bool) -> URL:
    """Valida TEST_DATABASE_URL sem conectar. Recusa qualquer destino não autorizado."""
    if not test_raw:
        raise UnauthorizedTestDatabase("TEST_DATABASE_URL não definida.")
    try:
        url = parse_database_url(test_raw, var_name="TEST_DATABASE_URL")
    except DatabaseConfigError as exc:
        raise UnauthorizedTestDatabase(str(exc)) from None
    target = normalize_target(url)
    if environment != "test":
        raise UnauthorizedTestDatabase(f"ENVIRONMENT precisa ser 'test' (atual: {environment!r}).")
    if not TEST_DB_NAME.fullmatch(target.database):
        raise UnauthorizedTestDatabase(
            f"Nome de banco não autorizado para testes: {target.database!r} "
            "(use prazoai_test ou prazoai_test_<sufixo>)."
        )
    if target.host != "local" and not (ci and target.host in CI_SERVICE_HOSTS):
        raise UnauthorizedTestDatabase(
            f"Host não autorizado para testes: {target.host!r} (só local; serviço do CI apenas com CI=true)."
        )
    if app_raw:
        try:
            app_target = normalize_target(parse_database_url(app_raw))
        except DatabaseConfigError:
            raise UnauthorizedTestDatabase(
                "DATABASE_URL inválida: não é possível garantir que TEST_DATABASE_URL aponta para outro banco."
            ) from None
        if app_target == target:
            raise UnauthorizedTestDatabase("TEST_DATABASE_URL aponta para o MESMO destino que DATABASE_URL.")
    return url


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


def truncate_statement(metadata: MetaData) -> str | None:
    """TRUNCATE só das tabelas do projeto, com nomes qualificados e RESTRICT (nunca CASCADE)."""
    names = [f'"{SCHEMA}"."{t.name}"' for t in metadata.sorted_tables if t.schema == SCHEMA]
    if not names:
        return None
    return f"TRUNCATE TABLE {', '.join(names)} RESTRICT"
