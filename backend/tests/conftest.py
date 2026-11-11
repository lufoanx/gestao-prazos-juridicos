import os
import sys
import threading
from datetime import datetime, timedelta, timezone

import pytest

# Garante que "app" seja importável (raiz do backend no sys.path).
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


class FakeClock:
    """Relógio controlável para testes de expiração (sem sleep)."""

    def __init__(self, start: datetime | None = None) -> None:
        self._now = start or datetime(2026, 11, 9, 12, 0, tzinfo=timezone.utc)
        self._lock = threading.Lock()

    def now(self) -> datetime:
        with self._lock:
            return self._now

    def advance(self, seconds: float) -> None:
        with self._lock:
            self._now += timedelta(seconds=seconds)


class CapturingDelivery:
    """Adaptador de entrega injetado: captura as mensagens em vez de enviar e-mail."""

    def __init__(self) -> None:
        self.messages: list = []

    def send(self, message) -> None:
        self.messages.append(message)


class InstrumentedHasher:
    """Fábrica do hasher REAL (Argon2id) com contadores e pausas determinísticas.

    Criado sob demanda para não importar a aplicação antes do sys.path ser ajustado.
    - conta chamadas a hash/verify/verify_dummy;
    - `pause_after_verify(thread_name)` / `pause_after_hash(thread_name)`: a thread com
      esse nome sinaliza `reached` e espera `release` (Events, sem sleep);
    - `force_rehash=True` simula mudança de parâmetros (needs_rehash verdadeiro).
    """

    @staticmethod
    def create(force_rehash: bool = False):
        from app.security.passwords import PasswordHasher

        class _Instrumented(PasswordHasher):
            def __init__(self) -> None:
                super().__init__()
                self.counts = {"hash": 0, "verify": 0, "verify_dummy": 0}
                self.force_rehash = force_rehash
                self.reached = threading.Event()
                self.release = threading.Event()
                self._pause_verify_thread: str | None = None
                self._pause_hash_thread: str | None = None
                self._lock = threading.Lock()

            def _bump(self, key: str) -> None:
                with self._lock:
                    self.counts[key] += 1

            def pause_after_verify(self, thread_name: str) -> None:
                self._pause_verify_thread = thread_name

            def pause_after_hash(self, thread_name: str) -> None:
                self._pause_hash_thread = thread_name

            def _maybe_pause(self, target: str | None) -> None:
                if target is not None and threading.current_thread().name == target:
                    self.reached.set()
                    assert self.release.wait(30), "teste travou esperando release"

            def hash(self, password: str) -> str:
                self._bump("hash")
                result = super().hash(password)
                self._maybe_pause(self._pause_hash_thread)
                return result

            def verify(self, password_hash: str, password: str) -> bool:
                self._bump("verify")
                result = super().verify(password_hash, password)
                self._maybe_pause(self._pause_verify_thread)
                return result

            def verify_dummy(self, password: str) -> None:
                self._bump("verify_dummy")
                super().verify_dummy(password)

            def needs_rehash(self, password_hash: str) -> bool:
                return True if self.force_rehash else super().needs_rehash(password_hash)

        return _Instrumented()


@pytest.fixture
def clock() -> FakeClock:
    return FakeClock()


@pytest.fixture
def delivery() -> CapturingDelivery:
    return CapturingDelivery()


@pytest.fixture
def make_app(monkeypatch, request):
    """Fábrica de instâncias isoladas de create_app com relógio/entrega injetados.

    Com PRAZOAI_TEST_STORAGE=auth-postgres (CI), apps sem STORAGE/ENVIRONMENT explícitos são criadas
    em STORAGE=auth-postgres sobre o banco de TESTE autorizado (tabelas limpas antes de cada teste) e
    com segredo JWT estável; testes marcados `memory_only` (inspecionam o armazenamento em memória)
    são pulados nesse modo. Os engines das apps criadas são encerrados ao final do teste.
    """
    import app.core.config as config_module
    from app.main import create_app

    created = []
    sql_mode = os.environ.get("PRAZOAI_TEST_STORAGE") == "auth-postgres"
    if sql_mode and request.node.get_closest_marker("memory_only"):
        pytest.skip("teste específico do armazenamento em memória")

    def _make(clock=None, delivery=None, password_hasher=None, responsibility_port=None, processing_port=None,
              sql_checkpoint=None, **env):
        if sql_mode and not {"STORAGE", "ENVIRONMENT", "AUTH_STORAGE"} & set(env):
            request.getfixturevalue("pg_schema")
            url = request.getfixturevalue("pg_url")
            env = {"STORAGE": "auth-postgres", "ENVIRONMENT": "test",
                   "DATABASE_URL": url.render_as_string(hide_password=False),
                   "AUTH_JWT_SECRET": "segredo-jwt-estavel-dos-testes-auth-postgres-" + "y" * 24, **env}
        for k, v in env.items():
            monkeypatch.setenv(k, str(v))
        config_module.get_settings.cache_clear()
        try:
            app = create_app(
                clock=clock, password_reset_delivery=delivery, password_hasher=password_hasher,
                responsibility_port=responsibility_port, processing_port=processing_port,
                sql_checkpoint=sql_checkpoint,
            )
            created.append(app)
            return app
        finally:
            config_module.get_settings.cache_clear()

    yield _make
    for app in created:
        if getattr(app.state, "auth", None) is not None:
            app.state.auth.close()
    config_module.get_settings.cache_clear()


@pytest.fixture
def auth_app(make_app, clock, delivery):
    return make_app(clock=clock, delivery=delivery)


@pytest.fixture
def client(auth_app):
    from fastapi.testclient import TestClient

    return TestClient(auth_app, raise_server_exceptions=False)


# Fixture `org` da Etapa 3 (escritórios/equipe).
from tests.org_utils import org  # noqa: E402,F401

# ---------------------------------------------------------------- PostgreSQL (P1: fundação)
# Testes marcados com `postgres` usam um banco REAL descartável indicado por TEST_DATABASE_URL.
# Sem a variável, são PULADOS localmente; com PRAZOAI_REQUIRE_POSTGRES_TESTS=1 (CI), FALHAM.
# Toda a autorização acontece ANTES de qualquer conexão de escrita (tests/pg_support.py).


def pytest_configure(config):
    config.addinivalue_line("markers", "postgres: requer PostgreSQL real (TEST_DATABASE_URL)")
    config.addinivalue_line("markers", "memory_only: inspeciona o armazenamento em memória (pulado com auth-postgres)")


@pytest.fixture(scope="session")
def pg_engine_and_auth():
    from app.db.engine import create_db_engine
    from tests.pg_support import UnauthorizedTestDatabase, open_test_engine

    raw = os.environ.get("TEST_DATABASE_URL")
    if not raw:
        if os.environ.get("PRAZOAI_REQUIRE_POSTGRES_TESTS") == "1":
            pytest.fail("PRAZOAI_REQUIRE_POSTGRES_TESTS=1 exige TEST_DATABASE_URL.")
        pytest.skip("TEST_DATABASE_URL não definida: testes com PostgreSQL pulados.")
    try:
        engine, auth = open_test_engine(
            test_raw=raw, app_raw=os.environ.get("DATABASE_URL"),
            environment=os.environ.get("ENVIRONMENT", ""), ci=os.environ.get("CI") == "true",
            env=os.environ, engine_factory=create_db_engine,
        )
    except UnauthorizedTestDatabase as exc:
        pytest.fail(f"Banco de teste recusado: {exc}")
    try:
        yield engine, auth
    finally:
        engine.dispose()


@pytest.fixture(scope="session")
def pg_engine(pg_engine_and_auth):
    return pg_engine_and_auth[0]


@pytest.fixture(scope="session")
def pg_url(pg_engine_and_auth):
    return pg_engine_and_auth[1].url


@pytest.fixture(scope="session")
def pg_target(pg_engine_and_auth):
    return pg_engine_and_auth[1].target


@pytest.fixture(scope="session")
def pg_config(pg_engine_and_auth):
    from tests.pg_support import config_for_test_database

    return config_for_test_database(pg_engine_and_auth[1], os.environ)


@pytest.fixture
def pg_clean(pg_engine):
    """Limpa só as tabelas do projeto que existirem (qualificadas, RESTRICT) antes do teste."""
    from sqlalchemy import text

    import app.db.tables  # noqa: F401  (registra as tabelas no MetaData)
    from app.db.metadata import metadata
    from tests.pg_support import existing_project_tables, truncate_statement

    with pg_engine.begin() as conn:
        stmt = truncate_statement(metadata, existing_project_tables(conn))
        if stmt:
            conn.execute(text(stmt))
    return pg_engine


def alembic_config_for(conn):
    """Config do Alembic usando uma conexão já autorizada pela fixture protegida."""
    from pathlib import Path

    from alembic.config import Config

    cfg = Config(str(Path(__file__).resolve().parents[1] / "alembic.ini"))
    cfg.attributes["connection"] = conn
    return cfg


@pytest.fixture
def pg_schema(pg_engine):
    """Banco de teste na revisão head (0002) e com as tabelas do projeto vazias."""
    from alembic import command
    from sqlalchemy import text

    import app.db.tables  # noqa: F401
    from app.db.metadata import metadata
    from tests.pg_support import existing_project_tables, truncate_statement

    with pg_engine.begin() as conn:
        command.upgrade(alembic_config_for(conn), "head")
    with pg_engine.begin() as conn:
        stmt = truncate_statement(metadata, existing_project_tables(conn))
        if stmt:
            conn.execute(text(stmt))
    return pg_engine


STABLE_JWT_SECRET = "segredo-jwt-estavel-dos-testes-p3-" + "x" * 32   # reinício não perde tokens por segredo efêmero


@pytest.fixture
def pg_app(pg_schema, pg_url, make_app):
    """Fábrica de apps em STORAGE=auth-postgres sobre o banco de TESTE autorizado (relógio, entrega e
    pontos de controle injetáveis)."""
    raw = pg_url.render_as_string(hide_password=False)

    def build(clock=None, delivery=None, sql_checkpoint=None, **env):
        base = dict(STORAGE="auth-postgres", ENVIRONMENT="test", DATABASE_URL=raw, AUTH_JWT_SECRET=STABLE_JWT_SECRET)
        base.update(env)
        return make_app(clock=clock, delivery=delivery, sql_checkpoint=sql_checkpoint, **base)

    return build
