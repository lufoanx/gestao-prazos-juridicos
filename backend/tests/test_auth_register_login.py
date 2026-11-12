"""Etapa 2 — cadastro e login."""
import pytest

from tests.auth_utils import API, PASSWORD, bearer, error_code, login, register


def test_cadastro_valido_retorna_201_com_usuario_publico(client):
    resp = register(client)
    assert resp.status_code == 201
    body = resp.json()
    assert set(body) == {"id", "name", "email", "createdAt"}
    assert body["name"] == "Ana Souza"
    assert body["email"] == "ana@exemplo.com"
    assert len(body["id"]) >= 16
    # Cadastro não autentica: nenhum token é devolvido.
    assert "accessToken" not in body and "refreshToken" not in body


def test_ids_gerados_no_servidor_sao_unicos(client):
    a = register(client, email="a@exemplo.com").json()["id"]
    b = register(client, email="b@exemplo.com").json()["id"]
    assert a != b


def test_email_normalizado_e_nome_sem_espacos_extras(client):
    resp = register(client, email="  Ana.Souza@Exemplo.COM ", name="  Ana   Souza ")
    assert resp.status_code == 201
    assert resp.json()["email"] == "ana.souza@exemplo.com"
    assert resp.json()["name"] == "Ana Souza"
    # Login aceita qualquer variação de caixa/espaços do mesmo e-mail.
    assert login(client, email="ANA.SOUZA@exemplo.com").status_code == 200


@pytest.mark.parametrize("variant", ["ana@exemplo.com", "ANA@EXEMPLO.COM", " Ana@Exemplo.com "])
def test_email_duplicado_retorna_409_inclusive_variacao_de_caixa(client, variant):
    assert register(client, email="ana@exemplo.com").status_code == 201
    resp = register(client, email=variant)
    assert resp.status_code == 409
    assert error_code(resp) == "email_already_registered"


@pytest.mark.parametrize(
    "payload",
    [
        {"name": "Ana", "email": "nao-e-email", "password": PASSWORD},
        {"name": "Ana", "email": "", "password": PASSWORD},
        {"name": "Ana", "email": "ana@", "password": PASSWORD},
        {"name": "", "email": "ana@exemplo.com", "password": PASSWORD},
        {"name": "   ", "email": "ana@exemplo.com", "password": PASSWORD},
        {"name": "A" * 121, "email": "ana@exemplo.com", "password": PASSWORD},
        {"name": "Ana\x00", "email": "ana@exemplo.com", "password": PASSWORD},
        {"name": "Ana", "email": "ana@exemplo.com", "password": "curta"},
        {"name": "Ana", "email": "ana@exemplo.com", "password": "        "},
        {"name": "Ana", "email": "ana@exemplo.com", "password": "x" * 129},
        {"email": "ana@exemplo.com", "password": PASSWORD},
        {"name": "Ana", "password": PASSWORD},
        {"name": "Ana", "email": "ana@exemplo.com"},
    ],
)
def test_cadastro_invalido_retorna_422(client, payload):
    resp = client.post(f"{API}/auth/register", json=payload)
    assert resp.status_code == 422
    assert error_code(resp) == "validation_error"


def test_politica_de_senha_limites_exatos_sem_truncamento(client):
    assert register(client, email="min@exemplo.com", password="a" * 8).status_code == 201
    assert register(client, email="max@exemplo.com", password="b" * 128).status_code == 201
    assert register(client, email="over@exemplo.com", password="c" * 129).status_code == 422
    # Sem truncamento: a senha de 128 só funciona inteira.
    assert login(client, email="max@exemplo.com", password="b" * 128).status_code == 200
    assert login(client, email="max@exemplo.com", password="b" * 127).status_code == 401


@pytest.mark.parametrize(
    "extra",
    [
        {"role": "admin"},
        {"permissions": ["office.manage"]},
        {"officeId": "off1"},
        {"isAdmin": True},
        {"id": "meu-id"},
        {"membership": {"officeId": "off1"}},
        {"passwordHash": "$argon2id$x"},
    ],
)
def test_cadastro_rejeita_campos_privilegiados(client, extra):
    payload = {"name": "Ana", "email": "ana@exemplo.com", "password": PASSWORD, **extra}
    resp = client.post(f"{API}/auth/register", json=payload)
    assert resp.status_code == 422
    # E nada foi criado.
    assert register(client).status_code == 201


@pytest.mark.memory_only
def test_senha_armazenada_somente_como_hash_argon2id(client, auth_app):
    user_id = register(client).json()["id"]
    stored = auth_app.state.auth.store.users_by_id[user_id]
    assert stored.password_hash.startswith("$argon2id$")
    assert PASSWORD not in stored.password_hash
    assert PASSWORD not in repr(stored) and stored.password_hash not in repr(stored)
    # Nenhum outro lugar do estado guarda a senha em claro.
    assert PASSWORD not in repr(vars(auth_app.state.auth.store))


def test_login_valido_retorna_tokens_e_usuario_publico(client):
    register(client)
    resp = login(client)
    assert resp.status_code == 200
    body = resp.json()
    assert set(body) == {"accessToken", "refreshToken", "tokenType", "expiresIn", "user"}
    assert body["tokenType"] == "Bearer"
    assert body["expiresIn"] == 900
    assert set(body["user"]) == {"id", "name", "email", "createdAt"}
    assert client.get(f"{API}/auth/me", headers=bearer(body["accessToken"])).status_code == 200


def test_senha_incorreta_e_usuario_inexistente_tem_a_mesma_resposta(client):
    register(client)
    wrong = login(client, password="Senha-errada-999")
    missing = login(client, email="ninguem@exemplo.com")
    assert wrong.status_code == missing.status_code == 401
    assert wrong.json() == missing.json() == {
        "error": {"code": "invalid_credentials", "message": "E-mail ou senha inválidos."}
    }
    assert wrong.headers.get("www-authenticate") == "Bearer"


def test_usuario_inexistente_tambem_executa_verificacao_de_senha(auth_app, monkeypatch):
    """Equaliza o tratamento: sem usuário, uma verificação Argon2 equivalente ainda roda."""
    service = auth_app.state.auth.service
    calls = []
    original = service._hasher.verify_dummy
    monkeypatch.setattr(service._hasher, "verify_dummy", lambda p: calls.append(1) or original(p))
    from fastapi.testclient import TestClient

    client = TestClient(auth_app, raise_server_exceptions=False)
    assert login(client, email="ninguem@exemplo.com").status_code == 401
    assert calls == [1]


def test_login_com_payload_invalido_retorna_422(client):
    assert client.post(f"{API}/auth/login", json={"email": "ana@exemplo.com"}).status_code == 422
    assert client.post(f"{API}/auth/login", json={"email": "x", "password": "y"}).status_code == 422
    resp = client.post(f"{API}/auth/login", json={"email": "ana@exemplo.com", "password": PASSWORD, "remember": 1})
    assert resp.status_code == 422
