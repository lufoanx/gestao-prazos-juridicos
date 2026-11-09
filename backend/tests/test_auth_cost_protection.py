"""Auditoria da Etapa 2 — operações públicas caras não executam Argon2 sem necessidade.

O hasher é o REAL (Argon2id), instrumentado só para contar chamadas.
"""
import pytest
from fastapi.testclient import TestClient

from tests.auth_utils import API, PASSWORD, register
from tests.conftest import InstrumentedHasher

NEW = "Nova-senha-segura-456"


@pytest.fixture
def ctx(make_app, clock, delivery):
    def _ctx(**env):
        hasher = InstrumentedHasher.create()
        app = make_app(clock=clock, delivery=delivery, password_hasher=hasher, **env)
        return TestClient(app, raise_server_exceptions=False), hasher

    return _ctx


def _reset(client, token, password=NEW):
    return client.post(f"{API}/auth/reset-password", json={"token": token, "newPassword": password})


def _delta(hasher, before):
    return {k: hasher.counts[k] - before[k] for k in before}


def test_reset_com_token_inexistente_nao_calcula_argon2(ctx):
    client, hasher = ctx()
    before = dict(hasher.counts)
    resp = _reset(client, "token-que-nao-existe-1234567890")
    assert resp.status_code == 400
    assert _delta(hasher, before)["hash"] == 0


def test_reset_com_token_expirado_ou_usado_nao_calcula_argon2(ctx, delivery, clock):
    client, hasher = ctx()
    register(client)
    client.post(f"{API}/auth/forgot-password", json={"email": "ana@exemplo.com"})
    token = delivery.messages[-1].token
    before = dict(hasher.counts)
    assert _reset(client, token).status_code == 204
    assert _delta(hasher, before)["hash"] == 1          # caminho válido: exatamente um hash
    before = dict(hasher.counts)
    assert _reset(client, token).status_code == 400     # reutilizado
    assert _delta(hasher, before)["hash"] == 0
    client.post(f"{API}/auth/forgot-password", json={"email": "ana@exemplo.com"})
    expiring = delivery.messages[-1].token
    clock.advance(1800)
    before = dict(hasher.counts)
    assert _reset(client, expiring).status_code == 400  # expirado
    assert _delta(hasher, before)["hash"] == 0


def test_reset_com_payload_invalido_nao_calcula_argon2(ctx):
    client, hasher = ctx()
    before = dict(hasher.counts)
    assert _reset(client, "curto").status_code == 422
    assert _reset(client, "token-com-tamanho-ok-123456", password="x").status_code == 422
    assert _delta(hasher, before)["hash"] == 0


def test_reset_bloqueado_por_limite_nao_calcula_argon2(ctx, delivery, clock):
    client, hasher = ctx(AUTH_RESET_MAX_REQUESTS=2, AUTH_RESET_WINDOW_SECONDS=60)
    register(client)
    client.post(f"{API}/auth/forgot-password", json={"email": "ana@exemplo.com"})
    token = delivery.messages[-1].token
    assert _reset(client, "invalido-1-1234567890abc").status_code == 400
    assert _reset(client, "invalido-2-1234567890abc").status_code == 400
    before = dict(hasher.counts)
    blocked = _reset(client, token)                     # token válido, mas IP bloqueado
    assert blocked.status_code == 429
    assert blocked.headers["retry-after"] == "60"
    assert _delta(hasher, before)["hash"] == 0
    clock.advance(60)
    assert _reset(client, token).status_code == 204     # o token não foi gasto pelo bloqueio


def test_cadastro_limitado_por_ip_sem_calcular_argon2(ctx, clock):
    client, hasher = ctx(AUTH_REGISTER_MAX_REQUESTS=3, AUTH_REGISTER_WINDOW_SECONDS=3600)
    for i in range(3):
        assert register(client, email=f"p{i}@exemplo.com").status_code == 201
    before = dict(hasher.counts)
    blocked = register(client, email="p9@exemplo.com")
    assert blocked.status_code == 429
    assert blocked.json()["error"]["code"] == "rate_limited"
    assert blocked.headers["retry-after"] == "3600"
    assert _delta(hasher, before)["hash"] == 0
    clock.advance(3600)
    assert register(client, email="p9@exemplo.com").status_code == 201


def test_cadastro_duplicado_e_invalido_nao_calculam_argon2(ctx):
    client, hasher = ctx()
    assert register(client).status_code == 201
    before = dict(hasher.counts)
    assert register(client, email="ANA@exemplo.com").status_code == 409
    invalid = {"name": "A", "email": "x", "password": PASSWORD}
    assert client.post(f"{API}/auth/register", json=invalid).status_code == 422
    assert _delta(hasher, before)["hash"] == 0


def test_login_bloqueado_nao_verifica_senha(ctx):
    client, hasher = ctx()
    register(client)
    for _ in range(5):
        client.post(f"{API}/auth/login", json={"email": "ana@exemplo.com", "password": "errada-123456"})
    before = dict(hasher.counts)
    resp = client.post(f"{API}/auth/login", json={"email": "ana@exemplo.com", "password": PASSWORD})
    assert resp.status_code == 429
    delta = _delta(hasher, before)
    assert delta["verify"] == 0 and delta["verify_dummy"] == 0 and delta["hash"] == 0


def test_recuperacao_nunca_calcula_argon2(ctx):
    client, hasher = ctx()
    register(client)
    before = dict(hasher.counts)
    client.post(f"{API}/auth/forgot-password", json={"email": "ana@exemplo.com"})
    client.post(f"{API}/auth/forgot-password", json={"email": "ninguem@exemplo.com"})
    assert _delta(hasher, before) == {"hash": 0, "verify": 0, "verify_dummy": 0}
