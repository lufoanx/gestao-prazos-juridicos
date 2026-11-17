"""Apoio aos testes da E2 (RecoveryDispatcher): espera DETERMINÍSTICA pelo worker, gates e relógio
monotônico controlado. Nenhum sleep para ordenar corridas: só Events/Conditions com prazo de segurança.
"""
from __future__ import annotations

import threading

from tests.conftest import CapturingDelivery

WAIT = 30.0


def dispatcher(app):
    runtime = app.state.recovery
    assert runtime is not None, "recuperação desabilitada nesta app"
    return runtime.dispatcher


def start(app) -> None:
    """Para testes que usam o serviço diretamente (sem TestClient/lifespan)."""
    app.state.recovery.start()


def drain(app, timeout: float = WAIT) -> None:
    """Espera a fila esvaziar e o worker ficar ocioso (Condition do despachante; sem sleep)."""
    assert dispatcher(app).wait_idle(timeout), "worker não ficou ocioso no prazo de segurança"


def ask(app, email: str, ip: str = "10.9.9.9") -> None:
    """Pedido público pelo serviço (mesmo caminho da rota) e espera do processamento."""
    app.state.auth.service.request_password_recovery(email, ip)
    drain(app)


class FakeMonotonic:
    """Relógio monotônico controlado (segundos)."""

    def __init__(self, start: float = 1000.0) -> None:
        self._now = start
        self._lock = threading.Lock()

    def __call__(self) -> float:
        with self._lock:
            return self._now

    def advance(self, seconds: float) -> None:
        with self._lock:
            self._now += seconds


class GatedDelivery(CapturingDelivery):
    """Entrega que pausa a N-ésima mensagem (1-based) até `release`; registra a thread que entregou."""

    def __init__(self, pause_at: int | None = None) -> None:
        super().__init__()
        self.pause_at = pause_at
        self.reached = threading.Event()
        self.release = threading.Event()
        self.threads: list[str] = []
        self.on_send = None                    # gancho opcional (ex.: conferir o COMMIT por outra conexão)

    def send(self, message) -> None:
        self.threads.append(threading.current_thread().name)
        if self.on_send is not None:
            self.on_send(message)
        self.messages.append(message)
        if self.pause_at is not None and len(self.messages) == self.pause_at:
            self.reached.set()
            assert self.release.wait(WAIT), "teste travou esperando release"


class StageGate:
    """`sql_checkpoint` que pausa a thread do worker num ponto nomeado até `release`."""

    def __init__(self, name: str, thread_name: str = "prazoai-recovery-worker") -> None:
        self.name = name
        self.thread_name = thread_name
        self.reached = threading.Event()
        self.release = threading.Event()
        self.fail: BaseException | None = None

    def __call__(self, point: str) -> None:
        if point != self.name or threading.current_thread().name != self.thread_name:
            return
        self.reached.set()
        if self.fail is not None:
            raise self.fail
        assert self.release.wait(WAIT), "teste travou esperando release"
