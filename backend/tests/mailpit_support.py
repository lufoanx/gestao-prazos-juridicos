"""Fixtures do capturador Mailpit para a E3 (testes de integração reais).

Configuração (somente ambiente de teste):
- PRAZOAI_TEST_MAILPIT_SMTP=127.0.0.1:1025  — SMTP do capturador (loopback);
- PRAZOAI_TEST_MAILPIT_API=http://127.0.0.1:8025 — API de consulta (só o código de teste a usa);
- sem as variáveis, os testes são PULADOS localmente; com PRAZOAI_REQUIRE_MAILPIT_TESTS=1 (CI), FALHAM.
A caixa é esvaziada antes e depois de cada teste (em `finally`).
"""
from __future__ import annotations

import os

import pytest

from tests.mailpit_client import LOOPBACK, MailpitClient

ORIGIN = "http://localhost:3000"
FROM_NAME = "PrazoAI"
FROM_ADDRESS = "nao-responda@exemplo.com"


def _smtp_target() -> tuple[str, int] | None:
    raw = os.environ.get("PRAZOAI_TEST_MAILPIT_SMTP")
    if not raw:
        return None
    host, _, port = raw.rpartition(":")
    if host not in LOOPBACK or not port.isdigit():
        raise pytest.UsageError("PRAZOAI_TEST_MAILPIT_SMTP deve ser <loopback>:<porta> (capturador local).")
    return host, int(port)


@pytest.fixture
def mailpit():
    target, api = _smtp_target(), os.environ.get("PRAZOAI_TEST_MAILPIT_API")
    if not target or not api:
        if os.environ.get("PRAZOAI_REQUIRE_MAILPIT_TESTS") == "1":
            pytest.fail("PRAZOAI_REQUIRE_MAILPIT_TESTS=1 exige PRAZOAI_TEST_MAILPIT_SMTP e PRAZOAI_TEST_MAILPIT_API.")
        pytest.skip("capturador SMTP não configurado: testes da E3 pulados.")
    client = MailpitClient(api)
    client.wait_ready()
    client.delete_all()
    try:
        yield client, target
    finally:
        client.delete_all()                      # nada sensível fica no capturador depois do teste


def smtp_env(target: tuple[str, int], **over: str) -> dict[str, str]:
    """Configuração REAL do transporte (E1) apontando para o capturador local, sem TLS só por exceção
    explícita (loopback + ENVIRONMENT=test + SMTP_ALLOW_INSECURE_LOCAL=true)."""
    host, port = target
    env = {
        "EMAIL_TRANSPORT": "smtp", "PUBLIC_APP_ORIGIN": ORIGIN, "EMAIL_FROM": f"{FROM_NAME} <{FROM_ADDRESS}>",
        "SMTP_HOST": host, "SMTP_PORT": str(port), "SMTP_SECURITY": "none", "SMTP_ALLOW_INSECURE_LOCAL": "true",
        "SMTP_TIMEOUT_SECONDS": "5", "SMTP_SEND_DEADLINE_SECONDS": "10",
    }
    env.update(over)
    return env
