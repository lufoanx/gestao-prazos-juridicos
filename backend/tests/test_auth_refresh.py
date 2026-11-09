"""Etapa 2 — refresh com rotação, expiração, reutilização e consumo concorrente."""
import threading
from concurrent.futures import ThreadPoolExecutor

from tests.auth_utils import API, bearer, error_code, register_and_login


def _refresh(client, token):
    return client.post(f"{API}/auth/refresh", json={"refreshToken": token})


def test_refresh_valido_gira_o_token(client):
    tokens = register_and_login(client)
    resp = _refresh(client, tokens["refreshToken"])
    assert resp.status_code == 200
    body = resp.json()
    assert set(body) == {"accessToken", "refreshToken", "tokenType", "expiresIn"}
    assert body["refreshToken"] != tokens["refreshToken"]
    assert client.get(f"{API}/auth/me", headers=bearer(body["accessToken"])).status_code == 200
    # O novo refresh token funciona e é girado novamente.
    again = _refresh(client, body["refreshToken"])
    assert again.status_code == 200
    assert again.json()["refreshToken"] not in (tokens["refreshToken"], body["refreshToken"])


def test_refresh_token_armazenado_somente_como_hash(client, auth_app):
    tokens = register_and_login(client)
    store = auth_app.state.auth.store
    assert tokens["refreshToken"] not in store.session_by_current_hash
    assert tokens["refreshToken"] not in repr(vars(store))


def test_refresh_reutilizado_revoga_a_familia(client):
    tokens = register_and_login(client)
    rotated = _refresh(client, tokens["refreshToken"]).json()
    reuse = _refresh(client, tokens["refreshToken"])
    assert reuse.status_code == 401
    assert error_code(reuse) == "invalid_refresh_token"
    # Toda a família (sessão) foi revogada: o token novo e os access tokens deixam de valer.
    assert _refresh(client, rotated["refreshToken"]).status_code == 401
    assert client.get(f"{API}/auth/me", headers=bearer(rotated["accessToken"])).status_code == 401
    assert client.get(f"{API}/auth/me", headers=bearer(tokens["accessToken"])).status_code == 401


def test_reutilizacao_nao_afeta_outras_sessoes(client):
    a = register_and_login(client)
    b = client.post(f"{API}/auth/login", json={"email": "ana@exemplo.com", "password": "Senha-de-teste-123"}).json()
    _refresh(client, a["refreshToken"])
    assert _refresh(client, a["refreshToken"]).status_code == 401  # reutilização na sessão A
    assert client.get(f"{API}/auth/me", headers=bearer(b["accessToken"])).status_code == 200
    assert _refresh(client, b["refreshToken"]).status_code == 200


def test_refresh_expirado_retorna_401(client, clock):
    tokens = register_and_login(client)
    clock.advance(7 * 24 * 3600 - 1)
    rotated = _refresh(client, tokens["refreshToken"])
    assert rotated.status_code == 200
    clock.advance(1)  # vida absoluta da sessão atingida; a rotação não estende
    assert _refresh(client, rotated.json()["refreshToken"]).status_code == 401


def test_refresh_desconhecido_ou_malformado(client):
    assert _refresh(client, "token-inexistente-com-tamanho-ok").status_code == 401
    assert _refresh(client, "curto").status_code == 422
    assert client.post(f"{API}/auth/refresh", json={}).status_code == 422
    assert client.post(f"{API}/auth/refresh", json={"refresh_token": "x" * 40}).status_code == 422  # só camelCase


def test_consumo_concorrente_do_mesmo_refresh_token(client, auth_app):
    tokens = register_and_login(client)
    service = auth_app.state.auth.service
    n = 16
    barrier = threading.Barrier(n)

    def attempt(_):
        barrier.wait()
        try:
            return service.refresh(tokens["refreshToken"])
        except Exception as exc:  # AppError 401
            return exc

    with ThreadPoolExecutor(max_workers=n) as pool:
        results = list(pool.map(attempt, range(n)))
    winners = [r for r in results if not isinstance(r, Exception)]
    assert len(winners) == 1, "exatamente uma rotação deve vencer"
    assert all(getattr(r, "status_code", None) == 401 for r in results if isinstance(r, Exception))
    # As tentativas perdedoras usaram um token já girado → reutilização → família revogada.
    assert _refresh(client, winners[0].refresh_token).status_code == 401
