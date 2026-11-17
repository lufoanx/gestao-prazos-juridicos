"""RecoveryDispatcher: fila em memória, limitada e com prazo, com EXATAMENTE um worker (doc 21, §4.5–§4.8).

Admissão (`submit`, no caminho da requisição): só memória. Sob o lock de admissão, verifica o estado e
faz `put_nowait`: nenhuma consulta ao banco, nenhum token, nenhuma chamada ao transporte e nenhuma
espera por espaço. Fila cheia → descarte CONTADO (`queue_full`), mesma resposta neutra.

Worker (thread única, `daemon=False`, criada uma vez em `start`):
- FIFO; ao retirar, o item cujo tempo na fila ≥ prazo (fronteira exata incluída) é descartado ANTES
  de qualquer consulta (`queue_expired`) — relógio MONOTÔNICO injetável;
- antes de cada etapa (`lookup`, `issue`, `deliver`) verifica o evento de parada (`enter`);
- falha de um item não derruba o worker; morte inesperada → indisponível, pendências descartadas e
  contadas, SEM thread substituta.

Encerramento (`stop`), com orçamento monotônico TOTAL (`RECOVERY_SHUTDOWN_GRACE_SECONDS`) que cobre a
aquisição do lock, o cancelamento, a supervisão do filho SMTP e o `join`:
1. sob o lock de admissão (aquisição limitada ao orçamento): `stopping`, drenagem contada
   (`shutdown_discarded`), evento de parada;
2. cancelamento: banco (`CancelRegistry`, só com capacidade e propriedade confirmada) e SMTP
   (`delivery.cancel(timeout=restante)`);
3. `join` limitado ao restante, com no máximo um cancelamento de banco a cada 200 ms;
4. `stopped_clean` SOMENTE com thread encerrada, nenhuma conexão exclusiva aberta e nenhum filho sem
   coleta. Caso contrário `stopped_unclean` (log `dispatcher_stop_unclean`), recuperação indisponível.
O lock de admissão NUNCA é mantido durante banco, criação do filho ou SMTP.
"""
from __future__ import annotations

import logging
import secrets
import threading
import time
from collections import Counter, deque
from collections.abc import Callable
from dataclasses import dataclass
from enum import Enum

from app.recovery.cancel import CancelRegistry
from app.recovery.processor import RecoveryProcessor

logger = logging.getLogger("prazoai.recovery")

WORKER_THREAD_NAME = "prazoai-recovery-worker"
CANCEL_INTERVAL_SECONDS = 0.2


class DispatcherState(str, Enum):
    CREATED = "created"
    RUNNING = "running"
    STOPPING = "stopping"
    STOPPED_CLEAN = "stopped_clean"
    STOPPED_UNCLEAN = "stopped_unclean"
    FAILED = "failed"                     # worker morreu inesperadamente


class SubmitResult(str, Enum):
    ACCEPTED = "accepted"
    QUEUE_FULL = "queue_full"             # descartado e contado; resposta neutra igual
    UNAVAILABLE = "unavailable"           # 503 password_recovery_unavailable


@dataclass(frozen=True)
class _Item:
    email: str
    enqueued_at: float                    # relógio monotônico
    request_id: str                       # aleatório; só correlaciona logs

    def __repr__(self) -> str:            # nunca exibe o e-mail
        return f"_Item(request_id={self.request_id!r})"


class RecoveryDispatcher:
    def __init__(self, processor: RecoveryProcessor, delivery: object, *, queue_max: int, max_wait_seconds: float,
                 shutdown_grace_seconds: float, cancel_registry: CancelRegistry | None = None,
                 monotonic: Callable[[], float] = time.monotonic) -> None:
        self._processor = processor
        self._delivery = delivery
        self._queue_max = int(queue_max)
        self._max_wait = float(max_wait_seconds)
        self._grace = float(shutdown_grace_seconds)
        self._registry = cancel_registry
        self._monotonic = monotonic
        self._lock = threading.Lock()                    # lock de ADMISSÃO (e do estado)
        self._cond = threading.Condition(self._lock)
        self._queue: deque[_Item] = deque()
        self._state = DispatcherState.CREATED
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._stage = "idle"
        self._busy = False
        self._finished = 0                               # itens retirados e concluídos (qualquer resultado)
        self.counters: Counter[str] = Counter()

    # ------------------------------------------------------------------ ciclo de vida
    def start(self) -> None:
        with self._lock:
            if self._state is not DispatcherState.CREATED:
                return                                   # a thread é criada UMA vez
            self._thread = threading.Thread(target=self._run, name=WORKER_THREAD_NAME, daemon=False)
            self._state = DispatcherState.RUNNING
            self._thread.start()
        logger.info("dispatcher_started queue_max=%d max_wait_s=%s cancel_with_timeout=%s", self._queue_max,
                    self._max_wait, "n/a" if self._registry is None else str(self._registry.capability).lower())

    @property
    def state(self) -> DispatcherState:
        with self._lock:
            return self._state

    @property
    def available(self) -> bool:
        with self._lock:
            return self._admissible()

    def _admissible(self) -> bool:                       # com o lock
        thread = self._thread
        return (self._state is DispatcherState.RUNNING and not self._stop.is_set() and thread is not None
                and thread.is_alive() and bool(getattr(self._delivery, "available", True)))

    # ------------------------------------------------------------------ admissão (requisição)
    def submit(self, email: str) -> SubmitResult:
        """Só memória: nenhum banco, token ou transporte. Nunca espera espaço na fila."""
        with self._lock:
            if not self._admissible():
                self.counters["rejected_unavailable"] += 1
                return SubmitResult.UNAVAILABLE
            if len(self._queue) >= self._queue_max:
                self.counters["queue_full"] += 1
                return SubmitResult.QUEUE_FULL
            self._queue.append(_Item(email, self._monotonic(), secrets.token_hex(8)))
            self.counters["enqueued"] += 1
            self._cond.notify_all()
            return SubmitResult.ACCEPTED

    # ------------------------------------------------------------------ worker
    def _enter(self, stage: str) -> bool:
        with self._lock:
            if self._stop.is_set():
                return False
            self._stage = stage
            return True

    def _run(self) -> None:
        try:
            while True:
                with self._lock:
                    while not self._queue and not self._stop.is_set():
                        self._cond.wait()
                    if self._stop.is_set():
                        return
                    item = self._queue.popleft()
                    self._busy = True
                    self._stage = "dequeued"
                try:
                    category = self._handle(item)
                except Exception as exc:                 # falha de UM item: o worker segue
                    category = "item_failed"
                    logger.warning("recovery_item_failed error=%s", type(exc).__name__)
                logger.info("recovery_item request_id=%s result=%s", item.request_id, category)
                with self._lock:
                    self.counters[category] += 1
                    self._busy = False
                    self._stage = "idle"
                    self._finished += 1
                    self._cond.notify_all()
        except BaseException as exc:                     # morte inesperada (defeito)
            with self._lock:
                dropped = len(self._queue)
                self._queue.clear()
                self.counters["worker_died_discarded"] += dropped
                if self._state is DispatcherState.RUNNING:
                    self._state = DispatcherState.FAILED
                self._busy = False
                self._cond.notify_all()
            logger.error("recovery_worker_died error=%s discarded=%d", type(exc).__name__, dropped)
        finally:
            with self._lock:
                self._stage = "finished"
                self._cond.notify_all()

    def _handle(self, item: _Item) -> str:
        waited = self._monotonic() - item.enqueued_at
        if waited >= self._max_wait:                     # fronteira exata: vencido
            return "queue_expired"
        return self._processor.process(item.email, self._enter)

    # ------------------------------------------------------------------ espera determinística (testes/operação)
    def wait_idle(self, timeout: float) -> bool:
        """Espera (Condition, sem sleep) até a fila esvaziar e o worker ficar ocioso, ou o worker sair."""
        end = time.monotonic() + timeout
        with self._lock:
            while (self._queue or self._busy) and self._thread is not None and self._thread.is_alive():
                remaining = end - time.monotonic()
                if remaining <= 0:
                    return False
                self._cond.wait(remaining)
            return True

    def wait_state(self, target: DispatcherState, timeout: float) -> bool:
        """Espera (Condition) até o estado ser `target`."""
        end = time.monotonic() + timeout
        with self._lock:
            while self._state is not target:
                remaining = end - time.monotonic()
                if remaining <= 0:
                    return False
                self._cond.wait(remaining)
            return True

    def counter(self, name: str) -> int:
        with self._lock:
            return self.counters[name]

    def snapshot(self) -> dict[str, object]:
        with self._lock:
            return {"state": self._state.value, "queued": len(self._queue), "busy": self._busy,
                    "stage": self._stage, "finished": self._finished, "counters": dict(self.counters)}

    # ------------------------------------------------------------------ encerramento (§4.7)
    def stop(self) -> DispatcherState:
        deadline = time.monotonic() + self._grace

        def remaining() -> float:
            return max(0.0, deadline - time.monotonic())

        self._stop.set()                                 # thread-safe; nenhuma etapa nova depois disto
        if not self._lock.acquire(timeout=remaining()):
            return self._finish_unclean("admission_lock")
        try:
            if self._state in (DispatcherState.STOPPED_CLEAN, DispatcherState.STOPPED_UNCLEAN):
                return self._state
            never_started = self._thread is None
            if self._state in (DispatcherState.RUNNING, DispatcherState.CREATED, DispatcherState.FAILED):
                self._state = DispatcherState.STOPPING
            dropped = len(self._queue)
            self._queue.clear()
            self.counters["shutdown_discarded"] += dropped
            self._cond.notify_all()
        finally:
            self._lock.release()
        if dropped:
            logger.info("dispatcher_shutdown_discarded count=%d", dropped)
        if never_started:
            return self._mark_clean()
        cancel = getattr(self._delivery, "cancel", None)
        if callable(cancel):
            # Uma chamada: marca a parada no transporte (nenhum filho novo; criação em curso é encerrada
            # ao voltar) e encerra um filho publicado, com a supervisão limitada ao orçamento restante.
            cancel(timeout=remaining())
        thread = self._thread
        assert thread is not None
        last_cancel: float | None = None
        while thread.is_alive() and remaining() > 0:
            if self._registry is not None and self._registry.active:
                now = time.monotonic()
                if last_cancel is None or now - last_cancel >= CANCEL_INTERVAL_SECONDS:
                    last_cancel = now
                    self._registry.cancel_active(timeout=min(1.0, remaining()))
            thread.join(timeout=min(CANCEL_INTERVAL_SECONDS, remaining()))
        return self._conclude()

    def stage_now(self) -> str:
        with self._lock:
            return self._stage

    def _conclude(self) -> DispatcherState:
        thread_done = self._thread is None or not self._thread.is_alive()
        conn_open = self._registry is not None and self._registry.open_connections > 0
        child = bool(getattr(self._delivery, "has_unconfirmed_child", False))
        if thread_done and not conn_open and not child:
            return self._mark_clean()
        return self._finish_unclean(self._stage, worker_alive=not thread_done, connection_open=conn_open,
                                    child_unconfirmed=child)

    def _mark_clean(self) -> DispatcherState:
        with self._lock:
            self._state = DispatcherState.STOPPED_CLEAN
            self._cond.notify_all()
        logger.info("dispatcher_stopped_clean")
        return DispatcherState.STOPPED_CLEAN

    def _finish_unclean(self, stage: str, *, worker_alive: bool = True, connection_open: bool = False,
                        child_unconfirmed: bool = False) -> DispatcherState:
        # Sem esperar o lock (o orçamento já acabou): a admissão já está fechada pelo evento de parada
        # (`_admissible` o verifica) e o worker não inicia etapa nova.
        acquired = self._lock.acquire(blocking=False)
        try:
            self._state = DispatcherState.STOPPED_UNCLEAN
            if acquired:
                self._cond.notify_all()
        finally:
            if acquired:
                self._lock.release()
        logger.error("dispatcher_stop_unclean stage=%s worker_alive=%s connection_open=%s child_unconfirmed=%s",
                     stage, str(worker_alive).lower(), str(connection_open).lower(), str(child_unconfirmed).lower())
        return DispatcherState.STOPPED_UNCLEAN
