"""Auxiliares dos testes de autenticação (sem segredos reais)."""
API = "/api/v1"
PASSWORD = "Senha-de-teste-123"


def register(client, email="ana@exemplo.com", name="Ana Souza", password=PASSWORD):
    return client.post(f"{API}/auth/register", json={"name": name, "email": email, "password": password})


def login(client, email="ana@exemplo.com", password=PASSWORD):
    return client.post(f"{API}/auth/login", json={"email": email, "password": password})


def register_and_login(client, email="ana@exemplo.com", name="Ana Souza", password=PASSWORD):
    assert register(client, email=email, name=name, password=password).status_code == 201
    resp = login(client, email=email, password=password)
    assert resp.status_code == 200, resp.text
    return resp.json()


def bearer(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def error_code(resp) -> str:
    return resp.json()["error"]["code"]
