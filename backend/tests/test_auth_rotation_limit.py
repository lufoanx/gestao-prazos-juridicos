"""Auditoria v2 da Etapa 2 — histórico finito de rotações de refresh por sessão.

Política: cada sessão gira no máximo AUTH_MAX_REFRESH_ROTATIONS_PER_SESSION vezes; o
refresh seguinte ENCERRA a sessão (401 session_rotation_limit_reached, novo login).
Nenhum hash antigo é descartado enquanto a família existir.
"""
import threading
from concurrent.futures import ThreadPoolExecutor

import pytest
from fastapi.testclient import TestClient

from app.domain.auth import SessionView
from app.repositories.memory import MemoryAuthStore
from app.security.tokens import hash_opaque_token
from tests.auth_utils import API, bearer, login, register, register_and_login

CAP = 10
WEEK = 7 * 24 * 3600


@pytest.fixture
def capped(make_app, clock):
    app = make_app(clock=clock, AUTH_MAX_REFRESH_ROTATIONS_PER_SESSION=CAP, AUTH_LOGIN_MAX_FAILURES=100)
    return app, TestClient(app, raise_server_exceptions=False)


def _refresh(client, token):
    return client.post(f"{API}/auth/refresh", json={"refreshToken": token})


def _rotate(client, token, times):
    """Gira `times` vezes; devolve todos os refresh tokens (o inicial incluso) e o último par."""
    history, last = [token], None
    for _ in range(times):
        resp = _refresh(client, history[-1])
        assert resp.status_code == 200, resp.text
        last = resp.json()
        history.append(last["refreshToken"])
    return history, last


def _session(app):
    (session,) = app.state.auth.store.sessions.values()
    return session


# ---------- Limite de crescimento ----------
def test_historico_e_indices_nao_passam_do_teto(capped):
    app, client = capped
    tokens = register_and_login(client)
    history, last = _rotate(client, tokens["refreshToken"], CAP)
    store = app.state.auth.store
    assert _session(app).rotation_count == CAP
    assert len(store.session_by_used_hash) == CAP
    # Muitas tentativas depois do teto não fazem o estado crescer.
    for _ in range(500):
        assert _refresh(client, history[-1]).status_code == 401
    assert len(_session(app).used_refresh_hashes) == CAP
    assert len(store.session_by_used_hash) == CAP
    assert store.session_by_current_hash == {}


def test_sem_teto_explicito_o_padrao_e_finito(client, auth_app):
    settings_cap = auth_app.state.auth.store.max_rotations_per_session
    assert settings_cap == 1000


# ---------- Comportamento ao atingir o teto ----------
def test_ao_atingir_o_teto_a_sessao_e_encerrada_e_exige_novo_login(capped):
    app, client = capped
    tokens = register_and_login(client)
    other = login(client).json()                       # outra sessão do mesmo usuário
    history, last = _rotate(client, tokens["refreshToken"], CAP)   # CAP rotações aceitas
    assert client.get(f"{API}/auth/me", headers=bearer(last["accessToken"])).status_code == 200
    resp = _refresh(client, history[-1])               # (CAP+1)-ésima: encerra
    assert resp.status_code == 401
    assert resp.json()["error"] == {
        "code": "session_rotation_limit_reached",
        "message": "Sessão encerrada por limite de renovações. Faça login novamente.",
    }
    assert resp.headers["www-authenticate"] == "Bearer"
    # Sessão revogada: o access token mais recente deixa de valer imediatamente.
    assert client.get(f"{API}/auth/me", headers=bearer(last["accessToken"])).status_code == 401
    assert _refresh(client, history[-1]).json()["error"]["code"] == "invalid_refresh_token"
    # Outras sessões não são afetadas e um novo login funciona.
    assert client.get(f"{API}/auth/me", headers=bearer(other["accessToken"])).status_code == 200
    assert login(client).status_code == 200


# ---------- Detecção de reutilização preservada ----------
def test_nenhum_hash_antigo_e_descartado_enquanto_a_familia_existe(capped):
    app, client = capped
    tokens = register_and_login(client)
    history, _ = _rotate(client, tokens["refreshToken"], CAP)
    store = app.state.auth.store
    sid = _session(app).id
    for old in history[:-1]:                           # todos os CAP tokens girados
        assert store.session_by_used_hash[hash_opaque_token(old)] == sid


def test_reuso_do_token_mais_antigo_ainda_revoga_a_familia_perto_do_teto(capped):
    app, client = capped
    tokens = register_and_login(client)
    history, last = _rotate(client, tokens["refreshToken"], CAP - 1)
    reuse = _refresh(client, history[0])               # o PRIMEIRO token, após CAP-1 rotações
    assert reuse.status_code == 401 and reuse.json()["error"]["code"] == "invalid_refresh_token"
    assert _session(app).revoked
    assert _refresh(client, history[-1]).status_code == 401
    assert client.get(f"{API}/auth/me", headers=bearer(last["accessToken"])).status_code == 401


def test_apos_encerramento_por_teto_o_historico_continua_reconhecido(capped):
    app, client = capped
    tokens = register_and_login(client)
    history, _ = _rotate(client, tokens["refreshToken"], CAP)
    _refresh(client, history[-1])                      # encerra pelo teto
    session = _session(app)
    assert session.revoked and len(session.used_refresh_hashes) == CAP
    assert _refresh(client, history[3]).status_code == 401
    assert len(session.used_refresh_hashes) == CAP     # reuso não acrescenta nada


# ---------- Concorrência na fronteira ----------
def _concurrent_refresh(service, token, n):
    barrier = threading.Barrier(n)

    def attempt(_):
        barrier.wait()
        try:
            return service.refresh(token)
        except Exception as exc:
            return exc

    with ThreadPoolExecutor(max_workers=n) as pool:
        return list(pool.map(attempt, range(n)))


def test_refresh_concorrente_na_ultima_rotacao_permitida(capped):
    app, client = capped
    tokens = register_and_login(client)
    history, _ = _rotate(client, tokens["refreshToken"], CAP - 1)
    results = _concurrent_refresh(app.state.auth.service, history[-1], 8)
    winners = [r for r in results if not isinstance(r, Exception)]
    assert len(winners) == 1                           # só uma rotação (a CAP-ésima)
    assert all(r.status_code == 401 for r in results if isinstance(r, Exception))
    session = _session(app)
    assert session.rotation_count == CAP               # nunca passa do teto
    assert len(app.state.auth.store.session_by_used_hash) == CAP
    assert session.revoked                             # perdedores = reutilização → família revogada


def test_refresh_concorrente_com_teto_ja_atingido(capped):
    app, client = capped
    tokens = register_and_login(client)
    history, _ = _rotate(client, tokens["refreshToken"], CAP)
    results = _concurrent_refresh(app.state.auth.service, history[-1], 8)
    assert all(isinstance(r, Exception) and r.status_code == 401 for r in results)
    codes = sorted(r.code for r in results)
    assert codes.count("session_rotation_limit_reached") == 1   # exatamente um encerra
    assert codes.count("invalid_refresh_token") == 7
    session = _session(app)
    assert session.revoked and session.rotation_count == CAP
    assert len(app.state.auth.store.session_by_used_hash) == CAP


# ---------- Limpeza após expiração ----------
def test_limpeza_completa_apos_expiracao(capped, clock):
    app, client = capped
    tokens = register_and_login(client)
    history, _ = _rotate(client, tokens["refreshToken"], CAP)
    _refresh(client, history[-1])                      # encerrada pelo teto
    store = app.state.auth.store
    clock.advance(WEEK - 1)
    assert app.state.auth.service._sessions.purge_expired(clock.now()) == 0   # ainda retida
    clock.advance(1)
    assert app.state.auth.service._sessions.purge_expired(clock.now()) == 1
    assert store.sessions == {}
    assert store.session_by_used_hash == {} and store.session_by_current_hash == {}
    assert store.session_ids_by_user == {}


# ---------- Leitura sem copiar o histórico ----------
def test_repositorio_devolve_visao_sem_historico(capped):
    app, client = capped
    tokens = register_and_login(client)
    _rotate(client, tokens["refreshToken"], 5)
    repo = app.state.auth.service._sessions
    view = repo.get(_session(app).id)
    assert isinstance(view, SessionView)
    assert view.rotation_count == 5
    assert not hasattr(view, "used_refresh_hashes") and not hasattr(view, "current_refresh_hash")


# ---------- Configuração inválida ----------
@pytest.mark.parametrize("value", ["0", "-1", "9", "100001", "abc", "1.5"])
def test_configuracao_invalida_do_teto_e_rejeitada(make_app, value):
    with pytest.raises(Exception):
        make_app(AUTH_MAX_REFRESH_ROTATIONS_PER_SESSION=value)


@pytest.mark.parametrize("value", [0, -5])
def test_store_rejeita_teto_invalido(value):
    with pytest.raises(ValueError):
        MemoryAuthStore(max_rotations_per_session=value)


def test_teto_minimo_aceito(make_app, clock):
    app = make_app(clock=clock, AUTH_MAX_REFRESH_ROTATIONS_PER_SESSION=10)
    client = TestClient(app, raise_server_exceptions=False)
    register(client)
    assert app.state.auth.store.max_rotations_per_session == 10
