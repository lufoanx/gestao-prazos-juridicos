"""E2 — RecoveryDispatcher com o transporte SMTP REAL da E1 (subprocesso supervisionado) e servidor SMTP
LOCAL controlado (`tests/smtp_test_server.py`, só 127.0.0.1). Nenhum provedor externo é contatado.

REAIS: filho `app/email/smtp_child.py`, servidor local, sinais e coleta. SIMULAÇÕES (identificadas em
cada teste): criação lenta (Popen embrulhado com gate), coleta que nunca confirma (dublê da E1) e filho
que ignora SIGTERM (`tests/email_children/ignore_term.py`).
"""
from __future__ import annotations

import email
import email.policy
import logging
import subprocess
import sys
import threading
import time

import pytest
from fastapi.testclient import TestClient

from app.email.composer import PasswordResetComposer
from app.recovery.delivery import TransportPasswordResetDelivery
from app.recovery.dispatcher import WORKER_THREAD_NAME, DispatcherState
from tests.auth_utils import API, PASSWORD, error_code, register
from tests.recovery_support import WAIT, dispatcher, drain
from tests.smtp_test_server import ServerOptions, SmtpTestServer
from tests.test_email_transport import CHILDREN, MSG, Capture, config, live_children, transport

pytestmark = pytest.mark.skipif(not sys.platform.startswith("linux"), reason="transporte SMTP só em Linux")
ORIGIN = "https://app.exemplo.com"


def smtp_delivery(port, **kw):
    cfg_over = kw.pop("cfg", {})
    t = transport(config(port, **cfg_over), **kw)
    return TransportPasswordResetDelivery(PasswordResetComposer(ORIGIN), t), t


def post_forgot(client, email="ana@exemplo.com"):
    return client.post(f"{API}/auth/forgot-password", json={"email": email})


def ignores_sigterm(pid: int) -> bool:
    """Observa em /proc se o processo já ignora SIGTERM (máscara SigIgn, bit 15)."""
    try:
        for line in open(f"/proc/{pid}/status"):
            if line.startswith("SigIgn:"):
                return bool(int(line.split()[1], 16) & (1 << 14))
    except OSError:
        return False
    return False


def worker_alive() -> bool:
    return any(t.name == WORKER_THREAD_NAME for t in threading.enumerate())


def test_fluxo_real_entrega_link_com_fragmento_e_token_funciona(make_app, clock, caplog):
    with SmtpTestServer(ServerOptions()) as srv:
        delivery, t = smtp_delivery(srv.port)
        with caplog.at_level(logging.DEBUG):
            app = make_app(clock=clock, delivery=delivery, STORAGE="memory")
            with TestClient(app) as client:
                register(client)
                assert post_forgot(client).status_code == 202
                drain(app)
                assert len(srv.opts.messages) == 1
                parsed = email.message_from_bytes(srv.opts.messages[0], policy=email.policy.default)
                text = parsed.get_content()
                assert parsed["To"] == "ana@exemplo.com"
                assert f"{ORIGIN}/redefinir-senha#" in text
                token = text.split("/redefinir-senha#", 1)[1].split()[0]
                body = {"token": token, "newPassword": "Nova-senha-1234"}
                assert client.post(f"{API}/auth/reset-password", json=body).status_code == 204
    assert dispatcher(app).counter("delivery_accepted") == 1 and t.spawned == 1
    for secret in (token, "ana@exemplo.com", PASSWORD, "Nova-senha-1234", "redefinir-senha#"):
        assert secret not in caplog.text


def test_encerramento_durante_smtp_encerra_e_coleta_o_filho(make_app, clock):
    hold = threading.Event()
    with SmtpTestServer(ServerOptions(hold_greeting=hold)) as srv:
        delivery, t = smtp_delivery(srv.port, popen=Capture())
        app = make_app(clock=clock, delivery=delivery, STORAGE="memory")
        client = TestClient(app)
        client.__enter__()
        register(client)
        assert post_forgot(client).status_code == 202
        assert srv.opts.connected.wait(WAIT)                            # filho conectado e preso na saudação
        started = time.monotonic()
        client.__exit__(None, None, None)                               # lifespan: protocolo de encerramento
        elapsed = time.monotonic() - started
        assert srv.opts.messages == []
    assert dispatcher(app).state is DispatcherState.STOPPED_CLEAN and elapsed < 5
    assert not worker_alive() and delivery.has_unconfirmed_child is False
    assert dispatcher(app).counter("delivery_cancelled") == 1
    assert live_children() == 0 and t.spawned == 1


def test_encerramento_durante_criacao_do_filho_nao_limpo_e_nada_transmitido(make_app, clock):
    """SIMULAÇÃO: a criação (Popen) fica retida além do orçamento. O encerramento não espera o lock da
    criação: retorna no orçamento como `stopped_unclean` (criação ainda não confirmada). Liberada a
    criação, o transporte reconhece a parada e encerra o filho ANTES de transmitir."""
    gate, entered = threading.Event(), threading.Event()

    def slow():
        entered.set()
        assert gate.wait(WAIT)

    cap = Capture(before=slow)
    with SmtpTestServer(ServerOptions()) as srv:
        delivery, t = smtp_delivery(srv.port, popen=cap)
        app = make_app(clock=clock, delivery=delivery, STORAGE="memory", RECOVERY_SHUTDOWN_GRACE_SECONDS="1")
        client = TestClient(app)
        client.__enter__()
        try:
            register(client)
            assert post_forgot(client).status_code == 202
            assert entered.wait(WAIT)
            started = time.monotonic()
            client.__exit__(None, None, None)
            elapsed = time.monotonic() - started
            assert dispatcher(app).state is DispatcherState.STOPPED_UNCLEAN and elapsed < 1.5
            assert delivery.has_unconfirmed_child is True                  # criação em curso
        finally:
            gate.set()
        for th in [x for x in threading.enumerate() if x.name == WORKER_THREAD_NAME]:
            th.join(WAIT)
        assert srv.opts.messages == []
    assert cap.children[0].returncode is not None and delivery.has_unconfirmed_child is False
    assert dispatcher(app).counter("delivery_cancelled") == 1 and t.spawned == 1


def test_cancelamento_do_transporte_respeita_o_orcamento_informado():
    """Regressão do ajuste mínimo na E1: `cancel(timeout)` limita SIGTERM → SIGKILL → coleta ao orçamento
    (antes, esperava `term_grace + reap_timeout` configurados, podendo exceder o orçamento de desligamento).
    SIMULAÇÃO: filho que ignora SIGTERM."""
    with SmtpTestServer(ServerOptions()) as srv:
        cap = Capture()
        t = transport(config(srv.port, send_deadline_seconds=30, term_grace_seconds=10, reap_timeout_seconds=10),
                      popen=cap, script=CHILDREN / "ignore_term.py")
        out = {}
        th = threading.Thread(target=lambda: out.setdefault("r", t.send(MSG)))
        th.start()
        deadline = time.monotonic() + WAIT
        while t._child is None and time.monotonic() < deadline:            # OBSERVA a publicação do filho
            time.sleep(0.01)                                               # (prazo só de proteção)
        assert t._child is not None
        while not ignores_sigterm(t._child.pid) and time.monotonic() < deadline:   # handler instalado
            time.sleep(0.01)
        assert ignores_sigterm(t._child.pid)
        started = time.monotonic()
        t.cancel(timeout=1.0)
        elapsed = time.monotonic() - started
        th.join(WAIT)
    assert elapsed < 1.5                                                   # sem o ajuste: até 20 s
    assert cap.children[0].returncode == -9 and out["r"].value == "cancelled"
    assert t.has_unconfirmed_child is False


def test_falha_de_coleta_torna_a_recuperacao_indisponivel(make_app, clock):
    """SIMULAÇÃO (dublê da E1): coleta que nunca confirma → transporte indisponível → `status` false e 503,
    nenhum novo filho, nenhuma repetição."""
    real = subprocess.Popen([sys.executable, str(CHILDREN / "ignore_term.py")], start_new_session=True,
                            stdin=subprocess.PIPE, stdout=subprocess.PIPE)

    class NeverReaped:
        pid, stdin, stdout, returncode = real.pid, real.stdin, real.stdout, None

        def communicate(self, data, timeout):
            raise subprocess.TimeoutExpired("filho", timeout)

        def poll(self):
            return None

        def wait(self, timeout):
            raise subprocess.TimeoutExpired("filho", timeout)

    calls = []

    def popen(*a, **kw):
        calls.append(1)
        return NeverReaped()

    try:
        delivery, t = smtp_delivery(1, popen=popen, cfg=dict(send_deadline_seconds=0.2, term_grace_seconds=0.1,
                                                              reap_timeout_seconds=0.1))
        app = make_app(clock=clock, delivery=delivery, STORAGE="memory", RECOVERY_SHUTDOWN_GRACE_SECONDS="1")
        with TestClient(app) as client:
            register(client)
            assert post_forgot(client).status_code == 202
            drain(app)
            assert client.get(f"{API}/auth/password-recovery/status").json() == {"available": False}
            resp = post_forgot(client)
            assert resp.status_code == 503 and error_code(resp) == "password_recovery_unavailable"
        assert len(calls) == 1 and dispatcher(app).counter("delivery_unavailable") == 1
        assert dispatcher(app).state is DispatcherState.STOPPED_UNCLEAN         # filho sem coleta confirmada
    finally:
        real.kill()
        real.wait(5)
