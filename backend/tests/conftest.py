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

    def _make(clock=None, delivery=None, **env):
        for k, v in env.items():
            monkeypatch.setenv(k, str(v))
        config_module.get_settings.cache_clear()
        try:
            return create_app(clock=clock, password_reset_delivery=delivery)
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
