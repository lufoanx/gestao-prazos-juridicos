"""Auditoria da Etapa 2 — consistência entre login, rehash, recuperação e redefinição.

Testes determinísticos: pausas com threading.Event/Barrier dentro do hasher real
(Argon2id), sem sleeps. Asserções sobre o resultado final valem para qualquer ordem.
"""
import threading
from concurrent.futures import ThreadPoolExecutor

import pytest

from app.domain.auth import AuthSession, PasswordResetToken
from app.security.tokens import hash_opaque_token
from tests.conftest import InstrumentedHasher

OLD = "Senha-antiga-123"
NEW = "Senha-nova-456"
EMAIL = "ana@exemplo.com"


@pytest.fixture
def setup(make_app, clock, delivery):
    def _setup(force_rehash=False, **env):
        hasher = InstrumentedHasher.create(force_rehash=force_rehash)
        app = make_app(clock=clock, delivery=delivery, password_hasher=hasher, **env)
        service = app.state.auth.service
        user = service.register("Ana", EMAIL, OLD, "10.0.0.1")
        return app, service, hasher, user

    return _setup


def _run(name, fn, out):
    def target():
        try:
            out[name] = fn()
        except Exception as exc:  # AppError
            out[name] = exc

    t = threading.Thread(target=target, name=name)
    t.start()
    return t


def _status(result):
    return getattr(result, "status_code", None)


def _user_sessions(app, user_id):
    store = app.state.auth.store
    return [s for s in store.sessions.values() if s.user_id == user_id]


# ---------- 1. Login × redefinição ----------
def test_login_pausado_apos_verificacao_nao_cria_sessao_apos_reset(setup, delivery):
    app, service, hasher, user = setup()
    service.forgot_password(EMAIL)
    token = delivery.messages[-1].token
    hasher.pause_after_verify("login")
    out = {}
    t = _run("login", lambda: service.login(EMAIL, OLD, "10.0.0.2"), out)
    assert hasher.reached.wait(30)                 # senha antiga verificada com sucesso…
    service.reset_password(token, NEW, "10.0.0.3")  # …e a redefinição conclui no meio
    hasher.release.set()
    t.join(30)
    assert _status(out["login"]) == 401            # credencial obsoleta: sem sessão
    assert _user_sessions(app, user.id) == []
    assert _status(_try(lambda: service.login(EMAIL, OLD, "10.0.0.4"))) == 401
    pair, _ = service.login(EMAIL, NEW, "10.0.0.5")
    assert service.authenticate(pair.access_token).user.id == user.id


def _try(fn):
    try:
        return fn()
    except Exception as exc:
        return exc


def test_sessao_criada_antes_do_reset_e_revogada(setup, delivery):
    app, service, hasher, user = setup()
    pair, _ = service.login(EMAIL, OLD, "10.0.0.2")
    service.forgot_password(EMAIL)
    service.reset_password(delivery.messages[-1].token, NEW, "10.0.0.3")
    assert _status(_try(lambda: service.authenticate(pair.access_token))) == 401
    assert _status(_try(lambda: service.refresh(pair.refresh_token))) == 401


def test_sessao_com_versao_de_credencial_antiga_e_rejeitada(setup, clock):
    """Defesa em profundidade: mesmo uma sessão ativa com versão antiga não autentica."""
    app, service, hasher, user = setup()
    pair, _ = service.login(EMAIL, OLD, "10.0.0.2")
    store = app.state.auth.store
    with store.lock:
        store.users_by_id[user.id].credential_version += 1  # credencial mudou
    assert _status(_try(lambda: service.authenticate(pair.access_token))) == 401
    assert _status(_try(lambda: service.refresh(pair.refresh_token))) == 401
    # E a criação condicional recusa sessões com versão antiga.
    stale = AuthSession(
        id="s-velha", user_id=user.id, created_at=clock.now(), expires_at=clock.now().replace(year=2027),
        current_refresh_hash="h", credential_version=0,
    )
    assert service._sessions.add_if_credentials_current(stale) is False


# ---------- 2. Rehash × redefinição ----------
def test_rehash_funciona_sem_concorrencia(setup):
    app, service, hasher, user = setup(force_rehash=True)
    before = app.state.auth.store.users_by_id[user.id].password_hash
    service.login(EMAIL, OLD, "10.0.0.2")
    after = app.state.auth.store.users_by_id[user.id]
    assert after.password_hash != before            # rehash gravado
    assert after.credential_version == 0            # mesma senha: versão inalterada
    assert service.login(EMAIL, OLD, "10.0.0.3")[0].access_token


def test_rehash_concorrente_nao_sobrescreve_senha_redefinida(setup, delivery):
    app, service, hasher, user = setup(force_rehash=True)
    service.forgot_password(EMAIL)
    token = delivery.messages[-1].token
    hasher.pause_after_hash("login")               # pausa após calcular o rehash da senha ANTIGA
    out = {}
    t = _run("login", lambda: service.login(EMAIL, OLD, "10.0.0.2"), out)
    assert hasher.reached.wait(30)
    service.reset_password(token, NEW, "10.0.0.3")
    hasher.release.set()
    t.join(30)
    stored = app.state.auth.store.users_by_id[user.id]
    assert stored.credential_version == 1
    assert hasher.verify(stored.password_hash, NEW) is True
    assert hasher.verify(stored.password_hash, OLD) is False
    # A sessão do login concorrente (criada antes do reset) foi revogada pelo reset.
    pair = out["login"][0]
    assert _status(_try(lambda: service.authenticate(pair.access_token))) == 401
    assert _status(_try(lambda: service.login(EMAIL, OLD, "10.0.0.4"))) == 401
    assert service.login(EMAIL, NEW, "10.0.0.5")


# ---------- 3. Recuperação concorrente ----------
def test_pedidos_concorrentes_de_recuperacao_deixam_um_unico_token_ativo(setup, delivery, clock):
    app, service, hasher, user = setup(AUTH_FORGOT_MAX_REQUESTS=100, AUTH_RESET_MAX_REQUESTS=100)
    n = 16
    barrier = threading.Barrier(n)

    def ask(_):
        barrier.wait()
        service.forgot_password(EMAIL)

    with ThreadPoolExecutor(max_workers=n) as pool:
        list(pool.map(ask, range(n)))
    store = app.state.auth.store
    active = [t for t in store.reset_tokens.values() if t.used_at is None and t.invalidated_at is None]
    assert len(active) == 1
    assert len(delivery.messages) == n
    results = [_try(lambda m=m: service.reset_password(m.token, NEW, "10.0.0.9")) for m in delivery.messages]
    assert sum(1 for r in results if r is None) == 1
    assert all(_status(r) == 400 for r in results if r is not None)


def test_pedido_pausado_na_entrega_nao_deixa_dois_tokens(setup, delivery):
    """Pedido A emite e pausa na entrega; pedido B completa; ao fim, só o token de B vale."""
    app, service, hasher, user = setup()
    reached, release = threading.Event(), threading.Event()
    original = delivery.send

    def slow_send(message):
        original(message)
        if threading.current_thread().name == "A":
            reached.set()
            assert release.wait(30)

    delivery.send = slow_send
    out = {}
    t = _run("A", lambda: service.forgot_password(EMAIL), out)
    assert reached.wait(30)
    service.forgot_password(EMAIL)
    release.set()
    t.join(30)
    token_a, token_b = delivery.messages[0].token, delivery.messages[1].token
    assert _status(_try(lambda: service.reset_password(token_a, NEW, "10.0.0.2"))) == 400
    assert _try(lambda: service.reset_password(token_b, NEW, "10.0.0.3")) is None


# ---------- 4. Redefinições concorrentes com tokens distintos (+ login) ----------
def _inject_active_token(app, user_id, raw, clock):
    store = app.state.auth.store
    with store.lock:
        store.reset_tokens[hash_opaque_token(raw)] = PasswordResetToken(
            hash_opaque_token(raw), user_id, clock.now(), clock.now().replace(year=2027)
        )


def test_redefinicoes_concorrentes_com_tokens_distintos_e_login(setup, clock):
    """Dois tokens ativos (estado anômalo injetado) + login com a senha antiga, em paralelo."""
    app, service, hasher, user = setup(AUTH_RESET_MAX_REQUESTS=100)
    old_pw = OLD
    for rnd in range(5):  # várias rodadas para variar a intercalação
        _inject_active_token(app, user.id, "token-distinto-A-1234567890", clock)
        _inject_active_token(app, user.id, "token-distinto-B-1234567890", clock)
        version_before = app.state.auth.store.users_by_id[user.id].credential_version
        barrier = threading.Barrier(3)

        def reset(raw, pw):
            barrier.wait()
            return _try(lambda: service.reset_password(raw, pw, "10.0.1.1"))

        def login():
            barrier.wait()
            return _try(lambda: service.login(EMAIL, old_pw, "10.0.1.2"))

        new_a, new_b = f"{NEW}-A{rnd}", f"{NEW}-B{rnd}"
        with ThreadPoolExecutor(max_workers=3) as pool:
            fa = pool.submit(reset, "token-distinto-A-1234567890", new_a)
            fb = pool.submit(reset, "token-distinto-B-1234567890", new_b)
            fl = pool.submit(login)
            ra, rb, rl = fa.result(), fb.result(), fl.result()
        assert [ra, rb].count(None) == 1, (ra, rb)   # exatamente uma redefinição vence
        assert _status(ra if ra is not None else rb) == 400
        stored = app.state.auth.store.users_by_id[user.id]
        assert stored.credential_version == version_before + 1
        winner_pw = new_a if ra is None else new_b
        assert hasher.verify(stored.password_hash, winner_pw)
        assert not hasher.verify(stored.password_hash, old_pw)
        # Nenhuma sessão com credencial anterior sobrevive: o login, se venceu, foi revogado.
        if not isinstance(rl, Exception):
            assert _status(_try(lambda: service.authenticate(rl[0].access_token))) == 401
        assert all(s.revoked or s.credential_version == stored.credential_version
                   for s in _user_sessions(app, user.id))
        active = [t for t in app.state.auth.store.reset_tokens.values()
                  if t.used_at is None and t.invalidated_at is None]
        assert active == []
        service._login_limiter.reset(f"10.0.1.2|{EMAIL}")
        old_pw = winner_pw


def test_reset_e_novo_pedido_concorrentes_mantem_no_maximo_um_token(setup, delivery):
    app, service, hasher, user = setup(AUTH_FORGOT_MAX_REQUESTS=100, AUTH_RESET_MAX_REQUESTS=100)
    for _ in range(5):
        service.forgot_password(EMAIL)
        token = delivery.messages[-1].token
        barrier = threading.Barrier(2)

        def reset():
            barrier.wait()
            return _try(lambda: service.reset_password(token, NEW, "10.0.2.1"))

        def ask():
            barrier.wait()
            service.forgot_password(EMAIL)

        with ThreadPoolExecutor(max_workers=2) as pool:
            pool.submit(ask)
            pool.submit(reset).result()
        active = [t for t in app.state.auth.store.reset_tokens.values()
                  if t.used_at is None and t.invalidated_at is None]
        assert len(active) <= 1
