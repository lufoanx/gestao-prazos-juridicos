"""E2 — RecoveryDispatcher, caminho público e limites (doc 21, §4.5–§4.7). Armazenamento em MEMÓRIA.

Coordenação determinística: Events/Conditions (gates na entrega e nos repositórios, `wait_idle`),
relógio monotônico controlado (`FakeMonotonic`) e relógio de parede injetado (`FakeClock`). Nenhum
sleep ordena corridas; os prazos das esperas servem só de proteção contra travamento.
Os cenários transacionais e de cancelamento no PostgreSQL estão em `test_recovery_postgres.py`; os
de subprocesso SMTP em `test_recovery_smtp.py`.
"""
from __future__ import annotations

import contextvars
import logging
import threading
import time

import pytest
from fastapi.testclient import TestClient

from app.recovery.dispatcher import WORKER_THREAD_NAME, DispatcherState
from app.security.tokens import hash_opaque_token
from tests.auth_utils import API, PASSWORD, error_code, register
from tests.conftest import CapturingDelivery
from tests.recovery_support import WAIT, FakeMonotonic, GatedDelivery, dispatcher, drain

SECRET = "segredo-do-bff-para-testes-" + "x" * 20
GENERIC = {"message": "Se o e-mail estiver cadastrado, enviaremos instruções de recuperação."}
MEM = {"STORAGE": "memory"}


def ip(n: int) -> dict:
    """IP do cliente pelo mecanismo CONFIÁVEL existente (segredo do intermediário)."""
    return {"X-PrazoAI-Proxy-Secret": SECRET, "X-PrazoAI-Client-IP": f"203.0.113.{n}"}


def post_forgot(client, email, headers=None):
    return client.post(f"{API}/auth/forgot-password", json={"email": email}, headers=headers or {})


def worker_threads() -> list[threading.Thread]:
    return [t for t in threading.enumerate() if t.name == WORKER_THREAD_NAME]


@pytest.fixture
def build(make_app, clock):
    def _build(delivery=None, monotonic=None, **env):
        overrides = {"monotonic": monotonic} if monotonic is not None else None
        return make_app(clock=clock, delivery=delivery or CapturingDelivery(), recovery_overrides=overrides,
                        TRUSTED_PROXY_SECRET=SECRET, **{**MEM, **env})

    return _build


def active_tokens(app):
    store = app.state.auth.store
    return [t for t in store.reset_tokens.values() if t.used_at is None and t.invalidated_at is None]


# ------------------------------------------------------------------ disponibilidade e contrato público
def test_status_expoe_somente_available(build, make_app, clock):
    with TestClient(build()) as client:
        resp = client.get(f"{API}/auth/password-recovery/status")
        assert resp.status_code == 200 and resp.json() == {"available": True}
    with TestClient(make_app(clock=clock, **MEM)) as client:            # disabled (padrão)
        assert client.get(f"{API}/auth/password-recovery/status").json() == {"available": False}


def test_sem_lifespan_o_worker_nao_existe_e_a_recuperacao_fica_indisponivel(build):
    """A thread só nasce no lifespan: sem ele, nenhuma admissão (503), nunca enfileirar sem consumidor."""
    app = build()
    client = TestClient(app, raise_server_exceptions=False)               # sem `with`
    register(client)
    resp = post_forgot(client, "ana@exemplo.com")
    assert resp.status_code == 503 and error_code(resp) == "password_recovery_unavailable"
    assert dispatcher(app).state is DispatcherState.CREATED and worker_threads() == []


def test_um_unico_worker_criado_uma_vez(build):
    before = len(worker_threads())
    app = build()
    with TestClient(app):
        assert len(worker_threads()) == before + 1
        app.state.recovery.start()                                       # idempotente: nenhuma thread nova
        assert len(worker_threads()) == before + 1
        assert worker_threads()[-1].daemon is False
    assert len(worker_threads()) == before


def test_resposta_neutra_para_existente_inexistente_e_worker_descarta_inexistente(build):
    delivery = CapturingDelivery()
    app = build(delivery)
    with TestClient(app) as client:
        register(client)
        a = post_forgot(client, "ana@exemplo.com", ip(1))
        b = post_forgot(client, "ninguem@exemplo.com", ip(2))
        drain(app)
    assert a.status_code == b.status_code == 202 and a.content == b.content and a.json() == GENERIC
    assert [m.email for m in delivery.messages] == ["ana@exemplo.com"]
    assert dispatcher(app).counter("unknown_user") == 1
    assert len(active_tokens(app)) == 1


def test_caminho_publico_nao_toca_repositorios_nem_entrega_no_contexto_da_requisicao(build):
    """Instrumentação por CONTEXTO DA REQUISIÇÃO: um middleware marca a requisição; repositórios e
    entrega falham o teste se forem tocados dentro dela. O worker (fora da requisição) os usa."""
    in_request: contextvars.ContextVar[bool] = contextvars.ContextVar("in_request", default=False)
    touched: list[str] = []

    class Delivery(CapturingDelivery):
        def send(self, message):
            if in_request.get():
                touched.append("delivery")
            super().send(message)

    delivery = Delivery()
    app = build(delivery)

    @app.middleware("http")
    async def mark(request, call_next):
        if request.url.path.endswith("/forgot-password"):
            token = in_request.set(True)
            try:
                return await call_next(request)
            finally:
                in_request.reset(token)
        return await call_next(request)

    processor = dispatcher(app)._processor
    for name, obj in (("users", processor._users), ("resets", processor._resets)):
        for attr in ("get_by_email", "issue_replacing_active"):
            if hasattr(obj, attr):
                original = getattr(obj, attr)

                def spy(*a, _o=original, _n=f"{name}.{attr}", **k):
                    if in_request.get():
                        touched.append(_n)
                    return _o(*a, **k)

                setattr(obj, attr, spy)
    with TestClient(app) as client:
        register(client)
        assert post_forgot(client, "ana@exemplo.com", ip(1)).status_code == 202
        assert post_forgot(client, "ninguem@exemplo.com", ip(2)).status_code == 202
        drain(app)
    assert touched == []
    assert len(delivery.messages) == 1                                    # o worker fez o trabalho


# ------------------------------------------------------------------ limites
def test_limite_por_ip_antes_do_limite_por_email_com_retry_after(build, clock):
    delivery = CapturingDelivery()
    app = build(delivery)
    with TestClient(app) as client:
        for i in range(10):
            assert post_forgot(client, f"p{i}@exemplo.com", ip(7)).status_code == 202
        blocked = post_forgot(client, "outra@exemplo.com", ip(7))
        assert blocked.status_code == 429 and error_code(blocked) == "rate_limited"
        assert blocked.headers["retry-after"] == "900"
        assert post_forgot(client, "outra@exemplo.com", ip(8)).status_code == 202   # outro IP confiável
        # Cabeçalhos arbitrários não mudam o IP: sem o segredo, vale o IP observado da conexão.
        forged = {"X-Forwarded-For": "198.51.100.9", "X-PrazoAI-Client-IP": "198.51.100.9"}
        for i in range(10):
            assert post_forgot(client, f"q{i}@exemplo.com", forged).status_code == 202
        assert post_forgot(client, "q10@exemplo.com", forged).status_code == 429
        wrong = {"X-PrazoAI-Proxy-Secret": "errado-" + "y" * 40, "X-PrazoAI-Client-IP": "198.51.100.10"}
        assert post_forgot(client, "q11@exemplo.com", wrong).status_code == 429     # segredo incorreto
        clock.advance(900)
        assert post_forgot(client, "p0@exemplo.com", ip(7)).status_code == 202
        drain(app)


def test_limite_por_email_preservado_entre_ips_distintos(build):
    app = build()
    with TestClient(app) as client:
        for n in range(3):
            assert post_forgot(client, "ana@exemplo.com", ip(10 + n)).status_code == 202
        resp = post_forgot(client, "ana@exemplo.com", ip(20))
        assert resp.status_code == 429 and resp.headers["retry-after"] == "900"
        drain(app)


def test_indisponivel_nao_consome_limites(make_app, clock):
    app = make_app(clock=clock, TRUSTED_PROXY_SECRET=SECRET, **MEM)       # disabled
    with TestClient(app) as client:
        for _ in range(12):
            assert post_forgot(client, "ana@exemplo.com", ip(1)).status_code == 503
    assert app.state.auth.service._forgot_ip_limiter.tracked_keys() == 0
    assert app.state.auth.service._forgot_limiter.tracked_keys() == 0


# ------------------------------------------------------------------ fila: teto, prazo, ordem
def test_fila_cheia_descarta_com_contador_e_mesma_resposta(build):
    delivery = GatedDelivery(pause_at=1)
    app = build(delivery, RECOVERY_QUEUE_MAX="10", AUTH_FORGOT_IP_MAX_REQUESTS="100")
    with TestClient(app) as client:
        register(client)
        assert post_forgot(client, "ana@exemplo.com", ip(1)).status_code == 202
        assert delivery.reached.wait(WAIT)                                # worker ocupado na entrega
        for i in range(10):
            assert post_forgot(client, f"x{i}@exemplo.com", ip(1)).status_code == 202
        full = post_forgot(client, "y@exemplo.com", ip(1))
        assert full.status_code == 202 and full.json() == GENERIC         # descarte neutro
        assert dispatcher(app).counter("queue_full") == 1
        assert dispatcher(app).snapshot()["queued"] == 10                 # memória limitada ao teto
        delivery.release.set()
        drain(app)
    assert dispatcher(app).counter("unknown_user") == 10


@pytest.mark.parametrize("waited, expired", [(9.999, False), (10.0, True)])
def test_item_vencido_na_fronteira_exata_e_descartado_antes_de_consultar_o_usuario(build, waited, expired):
    mono = FakeMonotonic()
    delivery = GatedDelivery(pause_at=1)
    app = build(delivery, monotonic=mono, RECOVERY_QUEUE_MAX_WAIT_SECONDS="10")
    users = dispatcher(app)._processor._users
    lookups: list[str] = []
    original = users.get_by_email

    def spy(email):
        if threading.current_thread().name == WORKER_THREAD_NAME:      # o cadastro também consulta
            lookups.append(email)
        return original(email)

    users.get_by_email = spy
    with TestClient(app) as client:
        register(client)
        register(client, email="bia@exemplo.com")
        assert post_forgot(client, "ana@exemplo.com", ip(1)).status_code == 202
        assert delivery.reached.wait(WAIT)                                # ana em entrega; bia na fila
        assert post_forgot(client, "bia@exemplo.com", ip(2)).status_code == 202
        mono.advance(waited)
        delivery.release.set()
        drain(app)
    assert ("bia@exemplo.com" in lookups) is (not expired)
    assert dispatcher(app).counter("queue_expired") == (1 if expired else 0)
    assert [m.email for m in delivery.messages] == (["ana@exemplo.com"] if expired
                                                   else ["ana@exemplo.com", "bia@exemplo.com"])
    bia = app.state.auth.users.get_by_email("bia@exemplo.com")
    assert any(t.user_id == bia.id for t in app.state.auth.store.reset_tokens.values()) is (not expired)


def test_dois_pedidos_do_mesmo_destinatario_fifo_so_o_ultimo_vale(build, clock):
    delivery = CapturingDelivery()
    app = build(delivery)
    with TestClient(app) as client:
        register(client)
        assert post_forgot(client, "ana@exemplo.com", ip(1)).status_code == 202
        clock.advance(5)
        assert post_forgot(client, "ana@exemplo.com", ip(1)).status_code == 202
        drain(app)
        first, second = delivery.messages
        assert first.issued_at <= second.issued_at
        reset = {"token": first.token, "newPassword": "Nova-senha-1234"}
        assert client.post(f"{API}/auth/reset-password", json=reset).status_code == 400
        reset["token"] = second.token
        assert client.post(f"{API}/auth/reset-password", json=reset).status_code == 204


# ------------------------------------------------------------------ falhas e morte do worker
def test_falha_de_um_item_nao_derruba_o_worker(build):
    delivery = CapturingDelivery()
    app = build(delivery)
    users = dispatcher(app)._processor._users
    original = users.get_by_email
    calls = {"n": 0}

    def flaky(email):
        if threading.current_thread().name != WORKER_THREAD_NAME:      # o cadastro também consulta
            return original(email)
        calls["n"] += 1
        if calls["n"] == 1:
            raise RuntimeError("falha simulada na consulta")
        return original(email)

    users.get_by_email = flaky
    with TestClient(app) as client:
        register(client)
        assert post_forgot(client, "ana@exemplo.com", ip(1)).status_code == 202
        drain(app)
        assert post_forgot(client, "ana@exemplo.com", ip(1)).status_code == 202
        drain(app)
        assert client.get(f"{API}/auth/password-recovery/status").json() == {"available": True}
    assert dispatcher(app).counter("lookup_failed") == 1 and len(delivery.messages) == 1


class _Defect(BaseException):
    """Defeito que escapa do tratamento por item (simula morte inesperada da thread)."""


def test_morte_do_worker_torna_indisponivel_sem_thread_substituta(build):
    delivery = GatedDelivery(pause_at=1)
    app = build(delivery)

    def boom(message):
        CapturingDelivery.send(delivery, message)
        delivery.reached.set()
        assert delivery.release.wait(WAIT)
        raise _Defect()

    delivery.send = boom
    before = len(worker_threads())
    with TestClient(app) as client:
        register(client)
        assert post_forgot(client, "ana@exemplo.com", ip(1)).status_code == 202
        assert delivery.reached.wait(WAIT)
        for n in range(2):                                                # pendências que serão descartadas
            assert post_forgot(client, f"p{n}@exemplo.com", ip(2)).status_code == 202
        delivery.release.set()
        worker_threads()[-1].join(WAIT)
        assert dispatcher(app).state is DispatcherState.FAILED
        assert dispatcher(app).counter("worker_died_discarded") == 2
        assert client.get(f"{API}/auth/password-recovery/status").json() == {"available": False}
        resp = post_forgot(client, "ana@exemplo.com", ip(3))
        assert resp.status_code == 503 and error_code(resp) == "password_recovery_unavailable"
        assert len(worker_threads()) == before                            # nenhuma substituta
    assert dispatcher(app).state is DispatcherState.STOPPED_CLEAN         # thread já terminada


# ------------------------------------------------------------------ encerramento
def test_encerramento_ocioso_e_limpo_e_admissao_fechada(build):
    app = build()
    with TestClient(app) as client:
        register(client)
    d = dispatcher(app)
    assert d.state is DispatcherState.STOPPED_CLEAN and worker_threads() == []
    assert d.submit("ana@exemplo.com").value == "unavailable"


def test_encerramento_descarta_pendencias_contadas_e_nao_inicia_etapa_nova(build):
    """Parada reconhecida: pendências descartadas e contadas; o item em curso não emite token novo."""
    delivery = CapturingDelivery()
    app = build(delivery)
    users = dispatcher(app)._processor._users
    original = users.get_by_email
    reached, release = threading.Event(), threading.Event()

    def paused(email):
        if threading.current_thread().name == WORKER_THREAD_NAME and not reached.is_set():
            reached.set()
            assert release.wait(WAIT)
        return original(email)

    users.get_by_email = paused
    client = TestClient(app)
    client.__enter__()
    try:
        register(client)
        assert post_forgot(client, "ana@exemplo.com", ip(1)).status_code == 202
        assert reached.wait(WAIT)                                         # worker na etapa `lookup`
        for n in range(3):
            assert post_forgot(client, f"p{n}@exemplo.com", ip(2)).status_code == 202
        stopper = threading.Thread(target=client.__exit__, args=(None, None, None))
        stopper.start()
        d = dispatcher(app)
        assert d.wait_state(DispatcherState.STOPPING, WAIT)               # Condition, sem sleep
        assert d.counter("shutdown_discarded") == 3
        assert d.submit("x@exemplo.com").value == "unavailable"           # nenhuma admissão depois da parada
        release.set()                                                     # worker volta: `issue` recusado
        stopper.join(WAIT)
    finally:
        release.set()
    assert d.state is DispatcherState.STOPPED_CLEAN
    assert d.counter("stopped") == 1
    assert app.state.auth.store.reset_tokens == {} and delivery.messages == []


def test_encerramento_nao_limpo_no_orcamento_e_recuperacao_indisponivel(build):
    """Etapa presa além do orçamento (entrega bloqueada, sem cancelamento): o lifespan retorna dentro do
    orçamento, estado `stopped_unclean`, recurso indicado como ativo; nenhuma thread substituta."""
    delivery = GatedDelivery(pause_at=1)
    app = build(delivery, RECOVERY_SHUTDOWN_GRACE_SECONDS="1")
    client = TestClient(app)
    client.__enter__()
    try:
        register(client)
        assert post_forgot(client, "ana@exemplo.com", ip(1)).status_code == 202
        assert delivery.reached.wait(WAIT)
        started = time.monotonic()
        client.__exit__(None, None, None)                                 # lifespan: stop + dispose
        elapsed = time.monotonic() - started
        d = dispatcher(app)
        assert d.state is DispatcherState.STOPPED_UNCLEAN
        assert elapsed < 1.0 + 0.5                                        # orçamento + agendamento
        assert worker_threads()[-1].is_alive()                            # retorno ≠ término do processo
        assert d.available is False and d.submit("ana@exemplo.com").value == "unavailable"
    finally:
        delivery.release.set()
    for thread in worker_threads():
        thread.join(WAIT)
    assert worker_threads() == []


def test_admissao_concorrente_com_encerramento_conta_todos_os_itens(build):
    delivery = CapturingDelivery()
    app = build(delivery, AUTH_FORGOT_IP_MAX_REQUESTS="1000", AUTH_FORGOT_MAX_REQUESTS="100",
                RECOVERY_QUEUE_MAX="10000")
    d = dispatcher(app)
    d.start()
    barrier = threading.Barrier(9)
    results: list[str] = []
    lock = threading.Lock()

    def submit_many(k):
        barrier.wait()
        for i in range(50):
            r = d.submit(f"u{k}-{i}@exemplo.com").value
            with lock:
                results.append(r)

    threads = [threading.Thread(target=submit_many, args=(k,)) for k in range(8)]
    for t in threads:
        t.start()
    barrier.wait()
    state = app.state.recovery.stop()
    for t in threads:
        t.join(WAIT)
    assert state is DispatcherState.STOPPED_CLEAN
    snap = d.snapshot()["counters"]
    accepted = results.count("accepted")
    processed = sum(v for k, v in snap.items() if k not in {"enqueued", "shutdown_discarded", "queue_full",
                                                              "rejected_unavailable"})
    assert snap.get("enqueued", 0) == accepted
    assert accepted == processed + snap.get("shutdown_discarded", 0)     # nenhum item perdido sem contagem
    assert results.count("unavailable") == snap.get("rejected_unavailable", 0)
    assert d.snapshot()["queued"] == 0


# ------------------------------------------------------------------ redefinição × pedido pendente
def test_pedido_pendente_atravessa_uma_redefinicao_e_emite_token_valido(build):
    """Decisão D-E9 (documentada): a redefinição NÃO cancela pedidos ainda na fila. O pedido pendente é
    processado depois e emite um token novo e válido para o titular."""
    delivery = GatedDelivery(pause_at=2)
    app = build(delivery)
    with TestClient(app) as client:
        register(client)
        assert post_forgot(client, "ana@exemplo.com", ip(1)).status_code == 202
        drain(app)
        t1 = delivery.messages[0].token
        register(client, email="bia@exemplo.com")
        assert post_forgot(client, "bia@exemplo.com", ip(2)).status_code == 202
        assert delivery.reached.wait(WAIT)                                # worker ocupado com bia
        assert post_forgot(client, "ana@exemplo.com", ip(1)).status_code == 202   # pendente na fila
        reset = client.post(f"{API}/auth/reset-password", json={"token": t1, "newPassword": "Nova-senha-1234"})
        assert reset.status_code == 204
        delivery.release.set()
        drain(app)
        t2 = delivery.messages[-1].token
        assert delivery.messages[-1].email == "ana@exemplo.com" and t2 != t1
        assert app.state.auth.service._resets.is_active(hash_opaque_token(t2), app.state.auth.clock.now())
        ok = client.post(f"{API}/auth/reset-password", json={"token": t2, "newPassword": "Outra-senha-5678"})
        assert ok.status_code == 204


# ------------------------------------------------------------------ logs
def test_logs_sem_senha_token_mensagem_ou_destinatario(build, caplog):
    delivery = CapturingDelivery()
    with caplog.at_level(logging.DEBUG):
        app = build(delivery)
        with TestClient(app) as client:
            register(client)
            post_forgot(client, "ana@exemplo.com", ip(1))
            post_forgot(client, "ninguem@exemplo.com", ip(2))
            drain(app)
            token = delivery.messages[0].token
            client.post(f"{API}/auth/reset-password", json={"token": token, "newPassword": "Nova-senha-1234"})
    text = caplog.text
    for secret in ("ana@exemplo.com", "ninguem@exemplo.com", token, PASSWORD, "Nova-senha-1234", "redefinir-senha#"):
        assert secret not in text
    assert "recovery_item request_id=" in text and "result=delivery_handed_off" in text
    assert "result=unknown_user" in text and "dispatcher_stopped_clean" in text
