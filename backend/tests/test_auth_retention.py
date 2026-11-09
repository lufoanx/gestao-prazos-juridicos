"""Auditoria da Etapa 2 — crescimento limitado do estado temporário (relógio injetado)."""
import pytest
from fastapi.testclient import TestClient

from app.security.rate_limit import OVERFLOW_KEY, RateLimiter
from app.security.tokens import hash_opaque_token
from tests.auth_utils import API, bearer, login, register, register_and_login
from tests.conftest import FakeClock

WEEK = 7 * 24 * 3600


# ---------- RateLimiter ----------
def test_limiter_remove_chaves_expiradas_na_proxima_operacao():
    clock = FakeClock()
    rl = RateLimiter(3, 60, clock)
    for i in range(500):
        rl.check_and_hit(f"k{i}")
    assert rl.tracked_keys() == 500
    clock.advance(60)
    rl.check_and_hit("nova")           # varredura periódica (uma janela depois)
    assert rl.tracked_keys() == 1


def test_limiter_varredura_explicita_e_eventos_parciais():
    clock = FakeClock()
    rl = RateLimiter(3, 60, clock)
    rl.check_and_hit("a")
    clock.advance(30)
    rl.check_and_hit("b")
    clock.advance(30)
    rl.sweep()
    assert rl.tracked_keys() == 1       # "a" expirou; "b" ainda tem evento na janela


def test_limiter_teto_de_chaves_usa_balde_de_transbordo():
    clock = FakeClock()
    rl = RateLimiter(2, 60, clock, max_keys=3)
    for k in ("a", "b", "c"):
        assert rl.check_and_hit(k) is None
    # Chaves novas além do teto compartilham o balde de transbordo (limite 2).
    assert rl.check_and_hit("d") is None
    assert rl.check_and_hit("e") is None
    assert rl.check_and_hit("f") == 60
    assert rl.tracked_keys() == 4       # 3 individuais + transbordo: crescimento limitado
    for i in range(1000):
        rl.check_and_hit(f"flood{i}")
    assert rl.tracked_keys() == 4
    # Chaves rastreadas mantêm seus próprios contadores.
    assert rl.check_and_hit("a") is None
    assert rl.check_and_hit("a") == 60


def test_inundacao_nao_zera_contador_de_chave_rastreada():
    clock = FakeClock()
    rl = RateLimiter(2, 60, clock, max_keys=2)
    rl.check_and_hit("vitima")
    rl.check_and_hit("vitima")
    assert rl.retry_after("vitima") == 60
    for i in range(100):
        rl.check_and_hit(f"atacante{i}")
    assert rl.retry_after("vitima") == 60   # não foi despejada pela inundação


def test_reset_nao_limpa_balde_de_transbordo():
    clock = FakeClock()
    rl = RateLimiter(1, 60, clock, max_keys=1)
    rl.check_and_hit("a")
    rl.check_and_hit("b")                 # vai para o transbordo
    rl.reset("b")                         # chave não rastreada: não zera o balde
    rl.reset(OVERFLOW_KEY)
    assert rl.check_and_hit("c") == 60


def test_apos_expirar_chaves_novas_voltam_a_ser_individuais():
    clock = FakeClock()
    rl = RateLimiter(1, 60, clock, max_keys=1)
    rl.check_and_hit("a")
    assert rl.check_and_hit("b") is None  # transbordo
    clock.advance(60)
    assert rl.check_and_hit("c") is None
    assert rl.check_and_hit("c") == 60    # contador próprio de "c"
    assert rl.check_and_hit("d") is None  # "d" no transbordo (vazio após expirar)


def test_limitador_de_login_via_http_tem_memoria_limitada(make_app, clock):
    app = make_app(clock=clock, AUTH_RATE_LIMIT_MAX_KEYS=10)
    client = TestClient(app, raise_server_exceptions=False)
    for i in range(50):
        client.post(f"{API}/auth/login", json={"email": f"u{i}@exemplo.com", "password": "qualquer-coisa"})
    assert app.state.auth.service._login_limiter.tracked_keys() <= 11


# ---------- Sessões ----------
def test_sessoes_expiradas_sao_removidas_com_seus_indices(client, auth_app, clock):
    first = register_and_login(client)
    store = auth_app.state.auth.store
    rotated = client.post(f"{API}/auth/refresh", json={"refreshToken": first["refreshToken"]}).json()
    assert len(store.sessions) == 1 and len(store.session_by_used_hash) == 1
    clock.advance(WEEK)
    login(client)                         # escrita dispara a limpeza periódica
    assert len(store.sessions) == 1       # só a sessão nova
    assert hash_opaque_token(first["refreshToken"]) not in store.session_by_used_hash
    assert hash_opaque_token(rotated["refreshToken"]) not in store.session_by_current_hash


def test_reuso_detectado_durante_toda_a_validade_mesmo_apos_limpeza(client, auth_app, clock):
    tokens = register_and_login(client)
    store = auth_app.state.auth.store
    rotated = client.post(f"{API}/auth/refresh", json={"refreshToken": tokens["refreshToken"]}).json()
    clock.advance(WEEK - 1)
    assert store.purge_sessions_locked(clock.now()) == 0      # ainda válida: preservada
    reuse = client.post(f"{API}/auth/refresh", json={"refreshToken": tokens["refreshToken"]})
    assert reuse.status_code == 401
    session = next(iter(store.sessions.values()))
    assert session.revoked                                     # família revogada
    assert client.post(f"{API}/auth/refresh", json={"refreshToken": rotated["refreshToken"]}).status_code == 401


def test_sessao_revogada_e_mantida_ate_expirar(client, auth_app, clock):
    tokens = register_and_login(client)
    store = auth_app.state.auth.store
    client.post(f"{API}/auth/logout", headers=bearer(tokens["accessToken"]))
    service = auth_app.state.auth.service
    assert service._sessions.purge_expired(clock.now()) == 0
    assert len(store.sessions) == 1
    clock.advance(WEEK)
    assert service._sessions.purge_expired(clock.now()) == 1
    assert store.sessions == {} and store.session_ids_by_user == {} and store.session_by_used_hash == {}


def test_limite_de_sessoes_por_usuario(make_app, clock):
    app = make_app(clock=clock, AUTH_MAX_SESSIONS_PER_USER=3)
    client = TestClient(app, raise_server_exceptions=False)
    register(client)
    pairs = []
    for _ in range(5):
        clock.advance(1)
        pairs.append(login(client).json())
    store = app.state.auth.store
    assert len(store.sessions) == 3
    for old in pairs[:2]:                 # as mais antigas foram removidas
        assert client.get(f"{API}/auth/me", headers=bearer(old["accessToken"])).status_code == 401
        assert client.post(f"{API}/auth/refresh", json={"refreshToken": old["refreshToken"]}).status_code == 401
    for recent in pairs[2:]:
        assert client.get(f"{API}/auth/me", headers=bearer(recent["accessToken"])).status_code == 200


def test_limite_de_sessoes_remove_primeiro_as_revogadas(make_app, clock):
    app = make_app(clock=clock, AUTH_MAX_SESSIONS_PER_USER=2)
    client = TestClient(app, raise_server_exceptions=False)
    register(client)
    a = login(client).json()
    clock.advance(1)
    b = login(client).json()
    client.post(f"{API}/auth/logout", headers=bearer(b["accessToken"]))   # b revogada (mais nova)
    clock.advance(1)
    c = login(client).json()
    assert client.get(f"{API}/auth/me", headers=bearer(a["accessToken"])).status_code == 200
    assert client.get(f"{API}/auth/me", headers=bearer(c["accessToken"])).status_code == 200


# ---------- Tokens de recuperação ----------
def test_tokens_de_recuperacao_inativos_sao_removidos(client, auth_app, delivery, clock):
    register(client)
    store = auth_app.state.auth.store
    repo = auth_app.state.auth.service._resets
    client.post(f"{API}/auth/forgot-password", json={"email": "ana@exemplo.com"})
    client.post(f"{API}/auth/forgot-password", json={"email": "ana@exemplo.com"})  # invalida o 1º
    assert len(store.reset_tokens) == 2
    assert repo.purge_expired(clock.now()) == 1                     # inválido removido
    active = delivery.messages[-1].token
    assert set(store.reset_tokens) == {hash_opaque_token(active)}
    clock.advance(1800)
    assert repo.purge_expired(clock.now()) == 1                     # expirado removido
    assert store.reset_tokens == {}


def test_limpeza_periodica_de_tokens_no_proximo_pedido(client, auth_app, delivery, clock):
    register(client, email="a@exemplo.com")
    register(client, email="b@exemplo.com")
    client.post(f"{API}/auth/forgot-password", json={"email": "a@exemplo.com"})
    clock.advance(1800)
    client.post(f"{API}/auth/forgot-password", json={"email": "b@exemplo.com"})
    store = auth_app.state.auth.store
    assert len(store.reset_tokens) == 1   # o de "a" (expirado) foi removido na escrita
    assert client.post(
        f"{API}/auth/reset-password", json={"token": delivery.messages[-1].token, "newPassword": "Nova-senha-123"}
    ).status_code == 204


@pytest.mark.parametrize("value", ["0", "-1"])
def test_configuracao_invalida_de_retencao_e_rejeitada(make_app, value):
    with pytest.raises(Exception):
        make_app(AUTH_MAX_SESSIONS_PER_USER=value)
