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
def make_app(monkeypatch):
    """Fábrica de instâncias isoladas de create_app com relógio/entrega injetados."""
    import app.core.config as config_module
    from app.main import create_app

    def _make(clock=None, delivery=None, password_hasher=None, responsibility_port=None, processing_port=None,
              **env):
        for k, v in env.items():
            monkeypatch.setenv(k, str(v))
        config_module.get_settings.cache_clear()
        try:
            return create_app(
                clock=clock, password_reset_delivery=delivery, password_hasher=password_hasher,
                responsibility_port=responsibility_port, processing_port=processing_port,
            )
        finally:
            config_module.get_settings.cache_clear()

    yield _make
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


@pytest.fixture(scope="session")
def pg_url():
    from tests.pg_support import UnauthorizedTestDatabase, authorize_test_database

    raw = os.environ.get("TEST_DATABASE_URL")
    if not raw:
        if os.environ.get("PRAZOAI_REQUIRE_POSTGRES_TESTS") == "1":
            pytest.fail("PRAZOAI_REQUIRE_POSTGRES_TESTS=1 exige TEST_DATABASE_URL.")
        pytest.skip("TEST_DATABASE_URL não definida: testes com PostgreSQL pulados.")
    try:
        return authorize_test_database(
            raw, os.environ.get("DATABASE_URL"),
            environment=os.environ.get("ENVIRONMENT", ""), ci=os.environ.get("CI") == "true",
        )
    except UnauthorizedTestDatabase as exc:
        pytest.fail(f"Banco de teste recusado: {exc}")


@pytest.fixture(scope="session")
def pg_config(pg_url):
    from app.core.config import Settings
    from app.db.config import database_config_from

    return database_config_from(Settings(_env_file=None), url=pg_url)


@pytest.fixture(scope="session")
def pg_engine(pg_config, pg_url):
    from app.db.engine import create_db_engine
    from tests.pg_support import normalize_target, verify_and_prepare

    engine = create_db_engine(pg_config, application_name="prazoai-tests")
    try:
        with engine.begin() as conn:
            verify_and_prepare(conn, normalize_target(pg_url))
        yield engine
    finally:
        engine.dispose()


@pytest.fixture
def pg_clean(pg_engine):
    """Limpa só as tabelas do projeto (P1: nenhuma) antes do teste."""
    from sqlalchemy import text

    from app.db.metadata import metadata
    from tests.pg_support import truncate_statement

    stmt = truncate_statement(metadata)
    if stmt:
        with pg_engine.begin() as conn:
            conn.execute(text(stmt))
    return pg_engine
