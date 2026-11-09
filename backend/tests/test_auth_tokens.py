"""Etapa 2 — validação de access token, sessão no servidor e logout."""
import base64
import json
import secrets
import time

import jwt
import pytest
from fastapi.testclient import TestClient

from tests.auth_utils import API, bearer, error_code, login, register_and_login

SECRET = secrets.token_urlsafe(48)  # gerado por execução; não é segredo real


@pytest.fixture
def signed_client(make_app, clock, delivery):
    """Cliente com segredo conhecido, para forjar tokens com finalidade/claims incorretos."""
    app = make_app(clock=clock, delivery=delivery, AUTH_JWT_SECRET=SECRET)
    return TestClient(app, raise_server_exceptions=False)


def _claims(token: str) -> dict:
    return jwt.decode(token, options={"verify_signature": False})


def test_sem_token_retorna_401(client):
    resp = client.get(f"{API}/auth/me")
    assert resp.status_code == 401
    assert error_code(resp) == "not_authenticated"
    assert resp.headers.get("www-authenticate") == "Bearer"


@pytest.mark.parametrize("header", ["Token abc", "Bearer", "Basic dXNlcjpwYXNz", "Bearer    "])
def test_cabecalho_malformado_retorna_401(client, header):
    assert client.get(f"{API}/auth/me", headers={"Authorization": header}).status_code == 401


def test_token_adulterado_retorna_401(client):
    tokens = register_and_login(client)
    head, payload, sig = tokens["accessToken"].split(".")
    data = json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))
    data["sub"] = "outro-usuario"
    forged_payload = base64.urlsafe_b64encode(json.dumps(data).encode()).rstrip(b"=").decode()
    for bad in (
        f"{head}.{forged_payload}.{sig}",
        f"{head}.{payload}.{sig[:-2]}{'AA' if sig[-2:] != 'AA' else 'BB'}",
        "nao.e.jwt",
        "x" * 40,
    ):
        resp = client.get(f"{API}/auth/me", headers=bearer(bad))
        assert resp.status_code == 401, bad
        assert error_code(resp) == "invalid_token"


def test_token_expirado_retorna_401_com_relogio_injetado(client, clock):
    tokens = register_and_login(client)
    clock.advance(899)
    assert client.get(f"{API}/auth/me", headers=bearer(tokens["accessToken"])).status_code == 200
    clock.advance(1)  # exatamente na expiração (900 s)
    assert client.get(f"{API}/auth/me", headers=bearer(tokens["accessToken"])).status_code == 401


def test_refresh_e_reset_token_nao_valem_como_access_token(client, delivery):
    tokens = register_and_login(client)
    assert client.get(f"{API}/auth/me", headers=bearer(tokens["refreshToken"])).status_code == 401
    client.post(f"{API}/auth/forgot-password", json={"email": "ana@exemplo.com"})
    reset_token = delivery.messages[-1].token
    assert client.get(f"{API}/auth/me", headers=bearer(reset_token)).status_code == 401


def _forge(base: dict, **changes) -> str:
    payload = {**base, **changes}
    payload = {k: v for k, v in payload.items() if v is not None}
    return jwt.encode(payload, SECRET, algorithm="HS256")


def test_finalidade_e_claims_incorretos_retornam_401(signed_client, clock):
    tokens = register_and_login(signed_client)
    base = _claims(tokens["accessToken"])
    me = f"{API}/auth/me"
    # Controle: o token reassinado com os mesmos claims é aceito (prova que o teste é válido).
    assert signed_client.get(me, headers=bearer(_forge(base))).status_code == 200
    cases = [
        _forge(base, typ="refresh"),
        _forge(base, typ="password_reset"),
        _forge(base, typ=None),
        _forge(base, aud="outra-api"),
        _forge(base, iss="outro-emissor"),
        _forge(base, sid="sessao-inexistente"),
        _forge(base, sub="outro-usuario"),
        _forge(base, exp=None),
        _forge(base, exp=int(clock.now().timestamp()) - 1),
        _forge(base, iat=int(clock.now().timestamp()) + 3600),
        jwt.encode(base, SECRET, algorithm="HS512"),
        jwt.encode(base, "outro-segredo-com-tamanho-suficiente-123456", algorithm="HS256"),
    ]
    for token in cases:
        assert signed_client.get(me, headers=bearer(token)).status_code == 401


def test_algoritmo_none_e_rejeitado(signed_client):
    tokens = register_and_login(signed_client)
    base = _claims(tokens["accessToken"])
    header = base64.urlsafe_b64encode(b'{"alg":"none","typ":"JWT"}').rstrip(b"=").decode()
    body = base64.urlsafe_b64encode(json.dumps(base).encode()).rstrip(b"=").decode()
    assert signed_client.get(f"{API}/auth/me", headers=bearer(f"{header}.{body}.")).status_code == 401


def test_access_token_tem_claims_esperados(client):
    tokens = register_and_login(client)
    claims = _claims(tokens["accessToken"])
    assert claims["typ"] == "access"
    assert claims["iss"] == "prazoai-backend" and claims["aud"] == "prazoai-api"
    assert claims["exp"] - claims["iat"] == 900
    assert {"sub", "sid", "jti"} <= set(claims)
    assert "email" not in claims and "password" not in claims


def test_logout_retorna_204_e_revoga_tokens_da_sessao(client):
    tokens = register_and_login(client)
    resp = client.post(f"{API}/auth/logout", headers=bearer(tokens["accessToken"]))
    assert resp.status_code == 204
    assert resp.content == b""
    # Access token revogado deixa de valer imediatamente (sessão verificada no servidor).
    assert client.get(f"{API}/auth/me", headers=bearer(tokens["accessToken"])).status_code == 401
    assert client.get(f"{API}/users/me", headers=bearer(tokens["accessToken"])).status_code == 401
    # Refresh da sessão encerrada também não vale.
    assert client.post(f"{API}/auth/refresh", json={"refreshToken": tokens["refreshToken"]}).status_code == 401
    # Logout repetido com o mesmo token: 401.
    assert client.post(f"{API}/auth/logout", headers=bearer(tokens["accessToken"])).status_code == 401


def test_logout_exige_autenticacao(client):
    assert client.post(f"{API}/auth/logout").status_code == 401


def test_logout_encerra_somente_a_sessao_atual(client):
    first = register_and_login(client)
    second = login(client).json()
    assert client.post(f"{API}/auth/logout", headers=bearer(first["accessToken"])).status_code == 204
    assert client.get(f"{API}/auth/me", headers=bearer(second["accessToken"])).status_code == 200
    assert client.post(f"{API}/auth/refresh", json={"refreshToken": second["refreshToken"]}).status_code == 200


def test_validacao_independe_do_relogio_real(client, clock):
    """O relógio injetado governa a expiração: avançar 1 dia expira mesmo sem passar tempo real."""
    tokens = register_and_login(client)
    started = time.monotonic()
    clock.advance(24 * 3600)
    assert client.get(f"{API}/auth/me", headers=bearer(tokens["accessToken"])).status_code == 401
    assert time.monotonic() - started < 5
