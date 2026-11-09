"""Etapa 2 — GET /auth/me, GET/PATCH /users/me."""
import pytest

from tests.auth_utils import API, bearer, register_and_login


def test_me_retorna_somente_dados_publicos_sem_membership(client):
    tokens = register_and_login(client)
    auth_me = client.get(f"{API}/auth/me", headers=bearer(tokens["accessToken"]))
    users_me = client.get(f"{API}/users/me", headers=bearer(tokens["accessToken"]))
    assert auth_me.status_code == users_me.status_code == 200
    assert auth_me.json() == {"user": users_me.json()}
    assert set(users_me.json()) == {"id", "name", "email", "createdAt"}
    assert "membership" not in auth_me.json()


def test_cada_usuario_acessa_somente_o_proprio_perfil(client):
    ana = register_and_login(client, email="ana@exemplo.com", name="Ana")
    bia = register_and_login(client, email="bia@exemplo.com", name="Bia")
    assert client.get(f"{API}/users/me", headers=bearer(ana["accessToken"])).json()["email"] == "ana@exemplo.com"
    assert client.get(f"{API}/users/me", headers=bearer(bia["accessToken"])).json()["email"] == "bia@exemplo.com"
    # Não existe rota por id nesta etapa (sem acesso a perfis de terceiros).
    other = ana["user"]["id"]
    assert client.get(f"{API}/users/{other}", headers=bearer(bia["accessToken"])).status_code in (404, 405)
    # Atualizar o próprio nome não afeta o outro usuário.
    client.patch(f"{API}/users/me", headers=bearer(bia["accessToken"]), json={"name": "Bia Lima"})
    assert client.get(f"{API}/users/me", headers=bearer(ana["accessToken"])).json()["name"] == "Ana"


def test_patch_atualiza_somente_o_nome(client):
    tokens = register_and_login(client)
    resp = client.patch(f"{API}/users/me", headers=bearer(tokens["accessToken"]), json={"name": "  Ana   Lima "})
    assert resp.status_code == 200
    body = resp.json()
    assert body["name"] == "Ana Lima"
    assert body["email"] == tokens["user"]["email"]
    assert body["id"] == tokens["user"]["id"]
    assert client.get(f"{API}/users/me", headers=bearer(tokens["accessToken"])).json()["name"] == "Ana Lima"


@pytest.mark.parametrize(
    "payload",
    [
        {"email": "novo@exemplo.com"},
        {"name": "Ana", "email": "novo@exemplo.com"},
        {"name": "Ana", "password": "Nova-senha-123"},
        {"name": "Ana", "id": "outro"},
        {"name": "Ana", "permissions": ["office.manage"]},
        {"name": "Ana", "officeId": "off1"},
        {"name": "Ana", "role": "admin"},
        {"name": "Ana", "preferences": {"theme": "dark"}},
        {"name": "Ana", "createdAt": "2020-01-01T00:00:00Z"},
        {},
        {"name": ""},
        {"name": "A" * 121},
    ],
)
def test_patch_rejeita_campos_imutaveis_privilegiados_ou_invalidos(client, payload):
    tokens = register_and_login(client)
    before = client.get(f"{API}/users/me", headers=bearer(tokens["accessToken"])).json()
    resp = client.patch(f"{API}/users/me", headers=bearer(tokens["accessToken"]), json=payload)
    assert resp.status_code == 422
    assert client.get(f"{API}/users/me", headers=bearer(tokens["accessToken"])).json() == before


def test_perfil_exige_autenticacao(client):
    assert client.get(f"{API}/users/me").status_code == 401
    assert client.patch(f"{API}/users/me", json={"name": "X"}).status_code == 401
