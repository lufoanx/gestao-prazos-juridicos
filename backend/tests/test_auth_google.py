"""Entrar com Google: verificação do ID token no backend e vínculo pelo e-mail verificado."""
import time

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa

from app.security.google_id_token import GOOGLE_ISSUERS, GoogleIdTokenVerifier
from tests.auth_utils import API, PASSWORD, bearer, error_code, login, register

CLIENT_ID = "123-teste.apps.googleusercontent.com"
NONCE = "nonce-da-tentativa-" + "x" * 24
_KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)
_OTHER_KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)


class _Resolver:
    """Substitui o JWKS do Google: devolve a chave pública conhecida (sem rede)."""

    def __init__(self, key=_KEY):
        self.key = key.public_key()

    def get_signing_key_from_jwt(self, token):
        return self.key


def _token(*, key=_KEY, **overrides) -> str:
    now = int(time.time())
    claims = {"iss": GOOGLE_ISSUERS[0], "aud": CLIENT_ID, "sub": "1098765432109876", "email": "ana@exemplo.com",
              "email_verified": True, "name": "Ana Google", "iat": now, "exp": now + 600, "nonce": NONCE}
    claims.update(overrides)
    claims = {k: v for k, v in claims.items() if v is not None}
    return jwt.encode(claims, key, algorithm="RS256", headers={"kid": "k1"})


@pytest.fixture
def gclient(client):
    client.app.state.auth.service.attach_google(GoogleIdTokenVerifier(CLIENT_ID, key_resolver=_Resolver()))
    return client


def google(client, token=None, nonce=NONCE):
    return client.post(f"{API}/auth/google", json={"idToken": token or _token(), "nonce": nonce})


def test_desligado_sem_client_id_responde_503(client):
    resp = google(client)
    assert resp.status_code == 503
    assert error_code(resp) == "google_login_unavailable"


def test_primeiro_acesso_cria_conta_e_entra(gclient):
    resp = google(gclient)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["user"]["email"] == "ana@exemplo.com"
    assert body["user"]["name"] == "Ana Google"
    assert {"accessToken", "refreshToken", "expiresIn", "user"} <= set(body)
    me = gclient.get(f"{API}/auth/me", headers=bearer(body["accessToken"]))
    assert me.status_code == 200
    assert me.json()["user"]["email"] == "ana@exemplo.com"
    # A conta criada pelo Google não tem senha conhecida: login por senha falha.
    assert login(gclient, password=PASSWORD).status_code == 401


def test_conta_existente_com_mesmo_email_e_a_mesma_conta(gclient):
    created = register(gclient, email="ana@exemplo.com").json()
    resp = google(gclient, _token(email="ANA@Exemplo.com"))
    assert resp.status_code == 200
    assert resp.json()["user"]["id"] == created["id"]
    assert resp.json()["user"]["name"] == "Ana Souza"           # o nome do cadastro não é trocado
    assert login(gclient).status_code == 200                      # a senha continua valendo


def test_segundo_login_google_reusa_a_conta(gclient):
    first = google(gclient).json()["user"]["id"]
    second = google(gclient).json()["user"]["id"]
    assert first == second


@pytest.mark.parametrize("bad", [
    {"aud": "outro-cliente.apps.googleusercontent.com"},
    {"iss": "https://evil.example.com"},
    {"exp": int(time.time()) - 3600, "iat": int(time.time()) - 7200},
    {"email_verified": False},
    {"email_verified": None},
    {"nonce": "nonce-de-outra-tentativa-" + "y" * 20},
    {"nonce": None},
    {"email": None},
    {"sub": None},
])
def test_token_invalido_e_recusado_sem_criar_conta(gclient, bad):
    resp = google(gclient, _token(**bad))
    assert resp.status_code == 401
    assert error_code(resp) == "invalid_google_token"
    assert login(gclient).status_code == 401                      # nenhuma conta foi criada
    assert register(gclient).status_code == 201


def test_assinatura_de_outra_chave_e_recusada(gclient):
    resp = google(gclient, _token(key=_OTHER_KEY))
    assert resp.status_code == 401
    assert error_code(resp) == "invalid_google_token"


def test_algoritmo_none_ou_hs256_recusado(gclient):
    now = int(time.time())
    claims = {"iss": GOOGLE_ISSUERS[0], "aud": CLIENT_ID, "sub": "1", "email": "ana@exemplo.com",
              "email_verified": True, "iat": now, "exp": now + 600, "nonce": NONCE}
    hs = jwt.encode(claims, "segredo-qualquer-com-tamanho-suficiente-32b", algorithm="HS256")
    assert google(gclient, hs).status_code == 401
    unsigned = jwt.encode(claims, None, algorithm="none")
    assert google(gclient, unsigned + "x" * 20).status_code in (401, 422)


def test_entrada_validada(gclient):
    assert gclient.post(f"{API}/auth/google", json={"idToken": "curto", "nonce": NONCE}).status_code == 422
    assert gclient.post(f"{API}/auth/google", json={"idToken": _token(), "nonce": "curto"}).status_code == 422
    assert gclient.post(f"{API}/auth/google", json={"idToken": _token(), "nonce": NONCE, "extra": 1}).status_code == 422


def test_limite_de_tentativas(gclient):
    codes = [google(gclient, _token(aud="x")).status_code for _ in range(8)]
    assert 429 in codes
    assert codes.index(429) >= 5


def test_nome_ausente_usa_parte_local_do_email(gclient):
    resp = google(gclient, _token(name=None, email="joao.silva@exemplo.com"))
    assert resp.status_code == 200
    assert resp.json()["user"]["name"] == "joao.silva"


def test_logs_nao_expoem_email_nem_token(gclient, caplog):
    token = _token()
    with caplog.at_level("INFO"):
        assert google(gclient, token).status_code == 200
        google(gclient, _token(aud="x"))
    text = caplog.text
    assert "ana@exemplo.com" not in text
    assert token not in text
    assert "1098765432109876" not in text
