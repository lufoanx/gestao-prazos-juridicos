"""Etapa 2 — dados sensíveis, limites de taxa, isolamento, produção e aliases."""
import logging
import threading
from concurrent.futures import ThreadPoolExecutor

import pytest
from fastapi.testclient import TestClient

from app.core.config import ProductionNotReleasedError
from tests.auth_utils import API, PASSWORD, bearer, error_code, login, register, register_and_login


# ---------- Dados sensíveis em respostas e logs ----------
def test_fluxo_completo_nao_vaza_senha_hash_ou_tokens(client, auth_app, delivery, caplog):
    caplog.set_level(logging.DEBUG)
    bodies = []
    r = register(client)
    bodies.append(r.text)
    tokens = login(client).json()
    bodies.append(client.get(f"{API}/auth/me", headers=bearer(tokens["accessToken"])).text)
    bodies.append(client.patch(f"{API}/users/me", headers=bearer(tokens["accessToken"]), json={"name": "Ana"}).text)
    refreshed = client.post(f"{API}/auth/refresh", json={"refreshToken": tokens["refreshToken"]}).json()
    bodies.append(login(client, password="errada-123456").text)
    bodies.append(client.post(f"{API}/auth/forgot-password", json={"email": "ana@exemplo.com"}).text)
    reset_token = delivery.messages[-1].token
    new_password = "Nova-senha-segura-456"
    bodies.append(
        client.post(f"{API}/auth/reset-password", json={"token": reset_token, "newPassword": new_password}).text
    )
    bodies.append(client.post(f"{API}/auth/register", json={"name": "X", "email": "x@y.com", "password": "123"}).text)

    user_id = r.json()["id"]
    password_hash = auth_app.state.auth.store.users_by_id[user_id].password_hash
    secrets_ = [PASSWORD, new_password, password_hash, tokens["accessToken"], tokens["refreshToken"],
                refreshed["accessToken"], refreshed["refreshToken"], reset_token]
    joined = "\n".join(bodies)
    for s in secrets_:
        assert s not in joined
        assert s not in caplog.text
    # Nenhum campo/valor de hash aparece (o nome do campo "password" em erro 422 é permitido).
    assert "passwordHash" not in joined and "password_hash" not in joined and "$argon2" not in joined
    assert "$argon2" not in caplog.text
    assert "traceback" not in caplog.text.lower()


def test_erro_de_validacao_nao_ecoa_a_senha(client):
    resp = client.post(f"{API}/auth/register", json={"name": "Ana", "email": "ana@exemplo.com", "password": "curta7"})
    assert resp.status_code == 422
    assert "curta7" not in resp.text


# ---------- Rate limiting ----------
def test_limite_de_tentativas_de_login_retorna_429(client, clock):
    register(client)
    for _ in range(5):
        assert login(client, password="errada-123456").status_code == 401
    blocked = login(client)  # mesmo com a senha correta
    assert blocked.status_code == 429
    assert error_code(blocked) == "rate_limited"
    assert int(blocked.headers["retry-after"]) == 300
    clock.advance(299)
    assert login(client).status_code == 429
    clock.advance(1)
    assert login(client).status_code == 200


def test_login_bem_sucedido_zera_o_contador(client):
    register(client)
    for _ in range(4):
        login(client, password="errada-123456")
    assert login(client).status_code == 200
    for _ in range(4):
        assert login(client, password="errada-123456").status_code == 401
    assert login(client).status_code == 200


def test_limite_de_login_e_por_email(client):
    register(client, email="ana@exemplo.com")
    register(client, email="bia@exemplo.com")
    for _ in range(5):
        login(client, email="ana@exemplo.com", password="errada-123456")
    assert login(client, email="ana@exemplo.com").status_code == 429
    assert login(client, email="bia@exemplo.com").status_code == 200


def test_limite_de_recuperacao_retorna_429_sem_revelar_existencia(client, clock, delivery):
    register(client)
    for email in ("ana@exemplo.com", "ninguem@exemplo.com"):
        for _ in range(3):
            assert client.post(f"{API}/auth/forgot-password", json={"email": email}).status_code == 202
        resp = client.post(f"{API}/auth/forgot-password", json={"email": email})
        assert resp.status_code == 429
        assert int(resp.headers["retry-after"]) == 900
    assert len(delivery.messages) == 3
    clock.advance(900)
    assert client.post(f"{API}/auth/forgot-password", json={"email": "ana@exemplo.com"}).status_code == 202


def test_limites_configuraveis(make_app, clock):
    client = TestClient(
        make_app(clock=clock, AUTH_LOGIN_MAX_FAILURES=2, AUTH_LOGIN_WINDOW_SECONDS=60), raise_server_exceptions=False
    )
    register(client)
    login(client, password="errada-123456")
    login(client, password="errada-123456")
    resp = login(client)
    assert resp.status_code == 429 and resp.headers["retry-after"] == "60"


# ---------- Concorrência no cadastro ----------
def test_cadastro_concorrente_do_mesmo_email_cria_um_unico_usuario(auth_app):
    service = auth_app.state.auth.service
    n = 12
    barrier = threading.Barrier(n)

    def attempt(i):
        barrier.wait()
        try:
            return service.register(f"Pessoa {i}", "mesmo@exemplo.com", PASSWORD, f"10.0.0.{i}")
        except Exception as exc:
            return exc

    with ThreadPoolExecutor(max_workers=n) as pool:
        results = list(pool.map(attempt, range(n)))
    created = [r for r in results if not isinstance(r, Exception)]
    assert len(created) == 1
    assert all(getattr(r, "status_code", None) == 409 for r in results if isinstance(r, Exception))
    assert len(auth_app.state.auth.store.users_by_id) == 1


def test_cadastro_concorrente_via_http_com_variacoes_de_caixa(client, auth_app):
    emails = ["Mesmo@Exemplo.com", "mesmo@exemplo.com", " MESMO@EXEMPLO.COM", "mesmo@EXEMPLO.com"] * 2
    barrier = threading.Barrier(len(emails))

    def attempt(email):
        barrier.wait()
        return register(client, email=email).status_code

    with ThreadPoolExecutor(max_workers=len(emails)) as pool:
        codes = list(pool.map(attempt, emails))
    assert codes.count(201) == 1 and codes.count(409) == len(emails) - 1
    assert list(auth_app.state.auth.store.user_id_by_email) == ["mesmo@exemplo.com"]


# ---------- Isolamento entre instâncias ----------
def test_instancias_de_create_app_nao_compartilham_estado(make_app, clock):
    a = TestClient(make_app(clock=clock), raise_server_exceptions=False)
    b = TestClient(make_app(clock=clock), raise_server_exceptions=False)
    tokens = register_and_login(a)
    assert login(b).status_code == 401
    assert register(b).status_code == 201  # e-mail livre na outra instância
    assert b.get(f"{API}/auth/me", headers=bearer(tokens["accessToken"])).status_code == 401


def test_isolamento_mesmo_com_o_mesmo_segredo(make_app, clock):
    secret = "segredo-de-teste-" + "z" * 40
    a = TestClient(make_app(clock=clock, AUTH_JWT_SECRET=secret), raise_server_exceptions=False)
    b = TestClient(make_app(clock=clock, AUTH_JWT_SECRET=secret), raise_server_exceptions=False)
    tokens = register_and_login(a)
    # Assinatura válida, mas a sessão não existe na instância B.
    assert b.get(f"{API}/auth/me", headers=bearer(tokens["accessToken"])).status_code == 401


# ---------- Produção e configuração ----------
def test_armazenamento_em_memoria_bloqueado_em_production(make_app):
    # P1 da persistência: production é recusada ANTES de compor a autenticação (bloqueio incondicional;
    # antes: InMemoryAuthBlockedError, que continua existindo como defesa adicional).
    with pytest.raises(ProductionNotReleasedError):
        make_app(ENVIRONMENT="production", AUTH_JWT_SECRET="s" * 48)


def test_production_sem_auth_tambem_e_recusada(make_app):
    # Antes da P1, production com AUTH_ENABLED=false servia /health. O projeto aprovado (doc 15, §5.6)
    # exige recusa incondicional até a entrega de prontidão: o comportamento foi alterado de propósito.
    with pytest.raises(ProductionNotReleasedError):
        make_app(ENVIRONMENT="production", AUTH_ENABLED="false")


def test_staging_exige_segredo_explicito(make_app):
    with pytest.raises(ValueError):
        make_app(ENVIRONMENT="staging")
    client = TestClient(make_app(ENVIRONMENT="staging", AUTH_JWT_SECRET="q" * 48), raise_server_exceptions=False)
    assert register(client).status_code == 201


@pytest.mark.parametrize("value", ["curto", "change-me-" + "x" * 40, "troque-este-valor-" + "x" * 40])
def test_segredo_curto_ou_placeholder_e_rejeitado(make_app, value):
    with pytest.raises(Exception):
        make_app(AUTH_JWT_SECRET=value)


def test_auth_desligado_remove_rotas(make_app):
    client = TestClient(make_app(AUTH_ENABLED="false"), raise_server_exceptions=False)
    assert client.post(f"{API}/auth/register", json={}).status_code == 404
    assert client.get(f"{API}/users/me").status_code == 404
    assert client.get(f"{API}/health").status_code == 200


# ---------- Aliases indevidos ----------
@pytest.mark.parametrize(
    "method,path",
    [
        ("post", "/api/auth/register"), ("post", "/api/auth/login"), ("post", "/api/auth/refresh"),
        ("post", "/api/auth/logout"), ("get", "/api/auth/me"), ("post", "/api/auth/forgot-password"),
        ("post", "/api/auth/reset-password"), ("get", "/api/users/me"), ("patch", "/api/users/me"),
    ],
)
def test_alias_legado_nao_expoe_rotas_de_auth(client, method, path):
    resp = getattr(client, method)(path, json={}) if method != "get" else client.get(path)
    assert resp.status_code == 404


def test_alias_legado_health_preservado_e_openapi(client):
    assert client.get("/api/health").json() == {"status": "ok", "service": "prazoai-backend"}
    paths = client.get("/openapi.json").json()["paths"]
    assert "/api/v1/auth/login" in paths and "/api/v1/users/me" in paths
    assert not any(p.startswith("/api/auth") or p.startswith("/api/users") for p in paths)
