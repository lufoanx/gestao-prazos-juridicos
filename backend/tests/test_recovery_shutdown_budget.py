"""Correção da auditoria da E2 — o orçamento de encerramento cobre TODAS as esperas por locks.

Defeito reproduzido em `69300a9`: com o lock do `CancelRegistry` (ou do transporte SMTP) retido,
`stop()`/`cancel(timeout)` ficavam bloqueados além do orçamento, porque propriedades e aquisições
esperavam o lock sem prazo e o prazo só começava a contar depois.

Classificação dos testes:
- DUBLÊS (determinísticos, sem banco nem SMTP): processador com gate (`StubProcessor`), conexão de driver
  falsa (`FakeDriverConnection`), lock que avança um relógio monotônico falso (`AdvancingLock`). O
  `CancelRegistry` e o `RecoveryDispatcher` são os REAIS.
- REAIS: `SubprocessSmtpTransport` da E1 (lock real do transporte; servidor SMTP local) e um cenário com
  PostgreSQL real (worker bloqueado num bloqueio de linha do teste + lock do registro retido).

Coordenação: Events/Barriers; locks retidos por threads auxiliares liberadas em `finally`. Os prazos das
esperas servem só de limite de observação (proteção contra travamento), nunca para ordenar corridas.
"""
from __future__ import annotations

import logging
import threading
import time
from contextlib import contextmanager

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from app.core.deadline import Deadline
from app.recovery.cancel import CancelOutcome, CancelRegistry
from app.recovery.delivery import TransportPasswordResetDelivery
from app.recovery.dispatcher import WORKER_THREAD_NAME, DispatcherState, RecoveryDispatcher
from tests.recovery_support import WAIT, FakeMonotonic

GRACE = 1.0
SLACK = 0.5                       # agendamento; o defeito ultrapassava o orçamento sem limite


# ------------------------------------------------------------------ dublês
class StubProcessor:
    """Processador DUBLÊ: entra em `lookup`, pausa no gate e só emite/entrega se `enter` permitir."""

    def __init__(self) -> None:
        self.reached = threading.Event()
        self.release = threading.Event()
        self.issued = 0
        self.delivered = 0
        self.results: list[str] = []

    def process(self, email, enter):
        if not enter("lookup"):
            self.results.append("stopped")
            return "stopped"
        self.reached.set()
        assert self.release.wait(WAIT), "teste travou esperando release"
        if not enter("issue"):
            self.results.append("stopped")
            return "stopped"
        self.issued += 1
        if not enter("deliver"):
            return "stopped_after_issue"
        self.delivered += 1
        return "delivery_handed_off"


class FakeDriverConnection:
    """Conexão de driver DUBLÊ: registra os timeouts recebidos por `cancel_safe` (nada é cancelado)."""

    def __init__(self) -> None:
        self.calls: list[tuple[float, float]] = []      # (instante monotônico real, timeout recebido)

    def cancel_safe(self, timeout: float) -> None:
        self.calls.append((time.monotonic(), timeout))


class AdvancingLock:
    """Lock real que, ao ser adquirido, avança um relógio monotônico FALSO (tempo gasto na espera)."""

    def __init__(self, clock: FakeMonotonic, spent: float) -> None:
        self._lock = threading.Lock()
        self._clock = clock
        self._spent = spent

    def acquire(self, blocking: bool = True, timeout: float = -1) -> bool:
        self._clock.advance(self._spent)
        return self._lock.acquire(blocking, timeout)

    def release(self) -> None:
        self._lock.release()

    __enter__ = acquire

    def __exit__(self, *exc) -> None:
        self.release()


@contextmanager
def held(lock):
    """Retém `lock` numa thread auxiliar até o fim do bloco (liberação garantida em `finally`)."""
    acquired, release = threading.Event(), threading.Event()

    def hold():
        with lock:
            acquired.set()
            release.wait(WAIT)

    t = threading.Thread(target=hold, name="lock-holder")
    t.start()
    assert acquired.wait(WAIT)
    try:
        yield
    finally:
        release.set()
        t.join(WAIT)


def build_dispatcher(processor, *, registry=None, delivery=None, grace=GRACE):
    class Delivery:
        available = True

        def send(self, message):
            return None

    return RecoveryDispatcher(processor, delivery or Delivery(), queue_max=10, max_wait_seconds=60,
                              shutdown_grace_seconds=grace, cancel_registry=registry)


def timed_stop(d):
    started = time.monotonic()
    state = d.stop()
    return state, time.monotonic() - started


def join_worker(d):
    if d._thread is not None:
        d._thread.join(WAIT)
        assert not d._thread.is_alive()


# ------------------------------------------------------------------ lock de admissão retido
def test_lock_de_admissao_retido_stop_respeita_o_orcamento_e_nada_e_emitido_depois(caplog):
    proc = StubProcessor()
    d = build_dispatcher(proc)
    d.start()
    try:
        assert d.submit("a@exemplo.com").value == "accepted"
        assert proc.reached.wait(WAIT)                              # worker em processamento (lookup)
        assert d.submit("b@exemplo.com").value == "accepted"        # pendente na fila
        with caplog.at_level(logging.INFO), held(d._lock):
            state, elapsed = timed_stop(d)
            assert state is DispatcherState.STOPPED_UNCLEAN and elapsed < GRACE + SLACK
            # Segunda chamada: não espera de novo sem limite (o lock continua retido).
            state2, elapsed2 = timed_stop(d)
            assert state2 is DispatcherState.STOPPED_UNCLEAN and elapsed2 < GRACE + SLACK
        assert "dispatcher_stop_unclean stage=" in caplog.text and "dispatcher_stopped_clean" not in caplog.text
    finally:
        proc.release.set()
    join_worker(d)
    assert proc.issued == 0 and proc.delivered == 0                 # parada reconhecida: nada novo
    assert d.counter("shutdown_discarded") == 1                     # pendência contada pelo worker
    assert d.submit("c@exemplo.com").value == "unavailable"
    assert d.state is DispatcherState.STOPPED_UNCLEAN               # nenhuma "promoção" a limpo depois


# ------------------------------------------------------------------ lock do registro retido
@pytest.mark.parametrize("capability", [True, False])
def test_lock_do_registro_retido_stop_respeita_o_orcamento(capability, caplog):
    registry = CancelRegistry(capability=capability)
    conn = FakeDriverConnection()
    registry.opened()
    registry.publish(conn)                                          # conexão "ATIVA" do worker (dublê)
    proc = StubProcessor()
    d = build_dispatcher(proc, registry=registry)
    d.start()
    try:
        assert d.submit("a@exemplo.com").value == "accepted"
        assert proc.reached.wait(WAIT)
        with caplog.at_level(logging.INFO), held(registry._lock):
            state, elapsed = timed_stop(d)
        assert state is DispatcherState.STOPPED_UNCLEAN and elapsed < GRACE + SLACK
        assert conn.calls == []                                     # sem propriedade confirmada: nenhum cancel
        assert "connection=unknown" in caplog.text                 # estado não confirmado ≠ fechado
    finally:
        proc.release.set()
    join_worker(d)
    assert proc.issued == 0 and proc.delivered == 0
    assert d.state is DispatcherState.STOPPED_UNCLEAN


def test_sem_provas_nao_ha_encerramento_limpo_mesmo_com_worker_terminado(caplog):
    """Worker ocioso termina na hora; o lock do registro retido impede confirmar a conexão → não limpo."""
    registry = CancelRegistry(capability=True)
    d = build_dispatcher(StubProcessor(), registry=registry)
    d.start()
    with caplog.at_level(logging.INFO), held(registry._lock):
        state, elapsed = timed_stop(d)
    assert state is DispatcherState.STOPPED_UNCLEAN and elapsed < GRACE + SLACK
    assert "worker_alive=false connection=unknown" in caplog.text
    assert "dispatcher_stopped_clean" not in caplog.text
    join_worker(d)


def test_orcamento_esgotado_antes_da_conclusao_nao_espera_de_novo():
    """O worker preso consome o orçamento no join; a conclusão usa tentativas NÃO bloqueantes."""
    registry = CancelRegistry(capability=True)
    proc = StubProcessor()
    d = build_dispatcher(proc, registry=registry)
    d.start()
    try:
        assert d.submit("a@exemplo.com").value == "accepted"
        assert proc.reached.wait(WAIT)
        with held(registry._lock):
            state, elapsed = timed_stop(d)
        assert state is DispatcherState.STOPPED_UNCLEAN and elapsed < GRACE + SLACK
    finally:
        proc.release.set()
    join_worker(d)
    assert proc.issued == 0


def test_varias_tentativas_de_cancelamento_consomem_o_mesmo_orcamento():
    """Cancelamentos repetidos (a cada intervalo) recebem sempre o RESTANTE do mesmo prazo."""
    registry = CancelRegistry(capability=True)
    conn = FakeDriverConnection()
    registry.opened()
    registry.publish(conn)
    proc = StubProcessor()
    d = build_dispatcher(proc, registry=registry)
    d.start()
    try:
        assert d.submit("a@exemplo.com").value == "accepted"
        assert proc.reached.wait(WAIT)
        started = time.monotonic()
        state = d.stop()
        elapsed = time.monotonic() - started
    finally:
        proc.release.set()
    join_worker(d)
    assert state is DispatcherState.STOPPED_UNCLEAN and elapsed < GRACE + SLACK
    assert len(conn.calls) >= 2                                     # várias tentativas…
    for at, timeout in conn.calls:                                  # …nenhuma além do restante
        assert timeout <= 1.0 and timeout <= (started + GRACE) - at + 0.01
    remaining = [(started + GRACE) - at for at, _ in conn.calls]
    assert remaining == sorted(remaining, reverse=True)             # o orçamento nunca é reiniciado
    assert proc.issued == 0


# ------------------------------------------------------------------ registro: lock descontado do driver
def test_tempo_gasto_no_lock_e_descontado_do_timeout_do_driver():
    clock = FakeMonotonic()
    registry = CancelRegistry(capability=True)
    registry._lock = AdvancingLock(clock, spent=0.6)              # dublê: a aquisição "custa" 0,6 s
    conn = FakeDriverConnection()
    registry.publish(conn)
    assert registry.cancel_active(Deadline(1.0, clock)) is CancelOutcome.ISSUED
    assert conn.calls[-1][1] == pytest.approx(0.4)                 # 1,0 − 0,6, não o timeout inteiro
    registry._lock = AdvancingLock(clock, spent=1.0)              # a aquisição consome TODO o prazo
    assert registry.cancel_active(Deadline(1.0, clock)) is CancelOutcome.BUDGET_EXHAUSTED
    assert len(conn.calls) == 1                                     # driver não chamado sem tempo
    assert registry.cancel_active(Deadline(5.0, clock), driver_cap=1.0) is CancelOutcome.ISSUED
    assert conn.calls[-1][1] == pytest.approx(1.0)                 # teto por tentativa preservado


def test_cancelamento_sem_capacidade_nao_toca_o_lock_nem_o_driver():
    registry = CancelRegistry(capability=False)
    conn = FakeDriverConnection()
    registry.publish(conn)
    with held(registry._lock):
        started = time.monotonic()
        assert registry.cancel_active(Deadline(1.0)) is CancelOutcome.NO_CAPABILITY
        assert time.monotonic() - started < 0.1                     # não esperou o lock
    assert conn.calls == []


def test_lock_do_registro_retido_cancel_active_limitado_ao_prazo():
    registry = CancelRegistry(capability=True)
    conn = FakeDriverConnection()
    registry.publish(conn)
    with held(registry._lock):
        started = time.monotonic()
        assert registry.cancel_active(Deadline(GRACE)) is CancelOutcome.LOCK_TIMEOUT
        assert time.monotonic() - started < GRACE + SLACK
        assert registry.snapshot(Deadline(0.05)) is None             # estado não confirmado
    assert conn.calls == []


# ------------------------------------------------------------------ transporte SMTP real
@pytest.fixture
def smtp_transport():
    import sys

    if not sys.platform.startswith("linux"):
        pytest.skip("transporte SMTP só em Linux")
    from tests.smtp_test_server import ServerOptions, SmtpTestServer
    from tests.test_email_transport import Capture, config, transport

    with SmtpTestServer(ServerOptions()) as srv:
        cap = Capture()
        yield transport(config(srv.port), popen=cap), srv, cap


def test_lock_do_transporte_retido_cancel_respeita_o_orcamento(smtp_transport):
    """REAL: lock do `SubprocessSmtpTransport` retido; `cancel(timeout=1)` volta no prazo, sem confirmar."""
    t, srv, cap = smtp_transport
    with held(t._lock):
        started = time.monotonic()
        confirmed = t.cancel(timeout=GRACE)
        elapsed = time.monotonic() - started
        assert confirmed is False and elapsed < GRACE + SLACK
        assert t.available is False                                 # parada sem confirmação: indisponível
        assert t.unconfirmed_child(0.05) is None                    # estado desconhecido, não "coletado"
    from tests.test_email_transport import MSG

    assert t.send(MSG).value == "cancelled"                         # nenhum filho depois da parada
    assert t.spawned == 0 and cap.children == [] and srv.opts.messages == []


def test_worker_bloqueado_no_lock_do_transporte_stop_no_orcamento_e_sem_envio(make_app, clock, smtp_transport):
    """REAL (transporte e servidor SMTP locais; armazenamento em memória): o worker entra na entrega e
    fica esperando o lock do transporte, retido pelo teste. `stop()` volta no orçamento como não limpo;
    liberado o lock, o envio reconhece a parada e NENHUM filho é criado."""
    from app.email.composer import PasswordResetComposer
    from tests.auth_utils import API, register

    t, srv, cap = smtp_transport
    delivery = TransportPasswordResetDelivery(PasswordResetComposer("https://app.exemplo.com"), t)
    entered = threading.Event()
    original_send = t.send

    def observed_send(message):
        entered.set()
        return original_send(message)

    t.send = observed_send
    app = make_app(clock=clock, delivery=delivery, STORAGE="memory", RECOVERY_SHUTDOWN_GRACE_SECONDS=str(GRACE))
    client = TestClient(app)
    client.__enter__()
    try:
        register(client)
        with held(t._lock):
            assert client.post(f"{API}/auth/forgot-password", json={"email": "ana@exemplo.com"}).status_code == 202
            assert entered.wait(WAIT)                               # worker dentro de `send`, antes do lock
            started = time.monotonic()
            client.__exit__(None, None, None)                       # lifespan → stop()
            elapsed = time.monotonic() - started
            d = app.state.recovery.dispatcher
            assert d.state is DispatcherState.STOPPED_UNCLEAN and elapsed < GRACE + SLACK
    finally:
        for th in [x for x in threading.enumerate() if x.name == WORKER_THREAD_NAME]:
            th.join(WAIT)
    assert d.counter("delivery_cancelled") == 1                     # parada reconhecida ao obter o lock
    assert t.spawned == 0 and cap.children == [] and srv.opts.messages == []
    assert d.state is DispatcherState.STOPPED_UNCLEAN


# ------------------------------------------------------------------ PostgreSQL real
@pytest.mark.postgres
def test_postgres_real_lock_do_registro_retido_com_capacidade(pg_app, pg_schema):
    """REAL: worker bloqueado num bloqueio de linha do teste (conexão exclusiva); lock do registro retido
    pelo teste. `stop()` volta no orçamento, NENHUM cancelamento é emitido sem propriedade confirmada e a
    consulta do worker segue esperando. Liberados os gates: a emissão já em curso conclui (corrida
    documentada), mas nada é enviado."""
    from app.db.tables import password_reset_tokens, users
    from tests.auth_sql_support import backend_pid, control_connection
    from tests.auth_utils import API, register
    from tests.conftest import CapturingDelivery
    from tests.test_recovery_postgres import LONG_DB, is_waiting, token_rows, wait_worker_waiting_lock

    delivery = CapturingDelivery()
    app = pg_app(delivery=delivery, recovery_overrides={"cancel_capability": True},
                 RECOVERY_SHUTDOWN_GRACE_SECONDS=str(GRACE), **LONG_DB)
    registry = app.state.recovery.registry
    client = TestClient(app)
    client.__enter__()
    try:
        register(client)
        with pg_schema.connect() as c:
            uid = c.execute(select(users.c.id).where(users.c.email == "ana@exemplo.com")).scalar_one()
        with control_connection(pg_schema) as holder:
            holder.execute(select(users.c.id).where(users.c.id == uid).with_for_update())
            assert client.post(f"{API}/auth/forgot-password", json={"email": "ana@exemplo.com"}).status_code == 202
            worker_pid = wait_worker_waiting_lock(pg_schema, backend_pid(holder))
            with held(registry._lock):
                started = time.monotonic()
                client.__exit__(None, None, None)
                elapsed = time.monotonic() - started
                assert app.state.recovery.dispatcher.state is DispatcherState.STOPPED_UNCLEAN
                assert elapsed < GRACE + SLACK
                assert registry.cancel_requests == 0
                assert is_waiting(pg_schema, worker_pid)            # nenhuma consulta cancelada sem propriedade
            holder.rollback()
    finally:
        for th in [x for x in threading.enumerate() if x.name == WORKER_THREAD_NAME]:
            th.join(WAIT)
    assert delivery.messages == []
    assert app.state.recovery.dispatcher.counter("stopped_after_issue") == 1
    assert token_rows(pg_schema) == 1 and registry.open_connections == 0
    _ = password_reset_tokens


# ------------------------------------------------------------------ 2ª auditoria: espera residual no cancel
class _FakeChild:
    """Filho DUBLÊ (nenhum processo real): nunca confirma término; pid inexistente não é sinalizado."""

    pid = -1
    stdin = stdout = None
    returncode = None

    def poll(self):
        return None


def test_cancel_nao_espera_sem_prazo_ao_publicar_indisponibilidade_apos_coleta_nao_confirmada(smtp_transport):
    """DUBLÊS (filho falso e `_terminate` com gate). `_terminate` devolve False (coleta não confirmada)
    enquanto outra thread retém o lock do transporte: `cancel(timeout=1)` volta no prazo, devolve False,
    o transporte fica indisponível e nenhum filho substituto é criado nem há reenvio."""
    t, srv, cap = smtp_transport
    child = _FakeChild()
    with t._lock:
        t._child = child                                         # filho "publicado" (dublê)
    reached, release = threading.Event(), threading.Event()

    def gated_terminate(c, deadline=None):
        assert c is child
        reached.set()
        assert release.wait(WAIT), "teste travou esperando release"
        return False                                             # coleta NÃO confirmada

    t._terminate = gated_terminate
    out: dict = {}
    started = time.monotonic()
    runner = threading.Thread(target=lambda: out.setdefault("r", t.cancel(timeout=GRACE)), name="canceller")
    runner.start()
    try:
        assert reached.wait(WAIT)                                # cancel dentro de `_terminate`
        with held(t._lock):                                      # lock retido ANTES do retorno de `_terminate`
            release.set()
            runner.join(GRACE + SLACK + 1.0)                     # limite de observação (> orçamento + folga)
            elapsed = time.monotonic() - started
            assert not runner.is_alive(), "cancel(timeout) bloqueado além do orçamento"
            assert elapsed < GRACE + SLACK
            assert out["r"] is False                             # nada confirmado
            assert t.available is False                          # publicado sem esperar o lock
    finally:
        release.set()
        runner.join(WAIT)
    from tests.test_email_transport import MSG

    assert t.send(MSG).value == "cancelled"                      # parada: nenhum filho substituto
    assert t.spawned == 0 and cap.children == [] and srv.opts.messages == []
    assert t.unconfirmed_child(0.1) is True                      # coleta continua NÃO confirmada
