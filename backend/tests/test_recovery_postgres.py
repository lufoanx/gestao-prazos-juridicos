"""E2 — RecoveryDispatcher no PostgreSQL REAL (doc 21, §4.5, §4.7 e §4.8).

Conexão exclusiva do worker (NullPool, `application_name=prazoai-recovery`), entrega depois do COMMIT
com os instantes persistidos, caminho público sem banco, encerramento durante SQL com cancelamento
pelo driver (só com capacidade e propriedade confirmada), ausência de cancelamento sem a capacidade,
registro em liberação, perda das pendências ao reiniciar e pedido pendente atravessando uma redefinição.

Coordenação: conexões de CONTROLE do teste seguram bloqueios; o teste só avança depois de VER a espera
no `pg_stat_activity` (a espera por observação tem prazo só de proteção). Nenhum sleep ordena corridas.
"""
from __future__ import annotations

import contextvars
import threading
import time

import psycopg
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import event, func, select, text

from app.core.deadline import Deadline
from app.db.tables import password_reset_tokens, users
from app.recovery.cancel import CancelOutcome, cancel_with_timeout_supported
from app.recovery.dispatcher import WORKER_THREAD_NAME, DispatcherState
from app.recovery.worker_db import WORKER_APPLICATION_NAME
from app.security.tokens import hash_opaque_token
from tests.auth_sql_support import Runner, backend_pid, control_connection, wait_for_lock_waiter
from tests.auth_utils import API, register
from tests.conftest import CapturingDelivery
from tests.recovery_support import WAIT, GatedDelivery, StageGate, dispatcher, drain

pytestmark = pytest.mark.postgres
EMAIL = "ana@exemplo.com"
LONG_DB = {"RECOVERY_DB_LOCK_TIMEOUT_MS": "20000", "RECOVERY_DB_STATEMENT_TIMEOUT_MS": "30000"}


def post_forgot(client, email=EMAIL):
    return client.post(f"{API}/auth/forgot-password", json={"email": email})


def token_rows(engine) -> int:
    with engine.connect() as c:
        return c.execute(select(func.count()).select_from(password_reset_tokens)).scalar_one()


def worker_backends(engine) -> list:
    with engine.connect() as c:
        return c.execute(text("SELECT pid, state, wait_event_type FROM pg_stat_activity "
                              "WHERE datname = current_database() AND application_name = :n"),
                         {"n": WORKER_APPLICATION_NAME}).all()


def wait_worker_waiting_lock(engine, holder_pid: int) -> int:
    """O backend do WORKER aparece esperando bloqueio (observação; prazo só de proteção). Atrás de outra
    espera na mesma linha, o PostgreSQL pode mostrá-lo bloqueado pela fila da tupla, não só pelo
    `holder`; por isso basta estar bloqueado por alguém."""
    deadline = time.monotonic() + WAIT
    query = text("SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND application_name = :n "
                 "AND wait_event_type = 'Lock' AND cardinality(pg_blocking_pids(pid)) > 0")
    with engine.connect() as observer:
        while time.monotonic() < deadline:
            pid = observer.execute(query, {"n": WORKER_APPLICATION_NAME}).scalar_one_or_none()
            observer.rollback()
            if pid is not None:
                return pid
            time.sleep(0.02)
    raise AssertionError("o worker não ficou esperando o bloqueio (proteção contra travamento)")


def is_waiting(engine, pid: int) -> bool:
    with engine.connect() as c:
        row = c.execute(text("SELECT wait_event_type FROM pg_stat_activity WHERE pid = :p"), {"p": pid}).first()
    return row is not None and row.wait_event_type == "Lock"


def user_id(engine, email=EMAIL):
    with engine.connect() as c:
        return c.execute(select(users.c.id).where(users.c.email == email)).scalar_one()


# ------------------------------------------------------------------ conexão exclusiva e COMMIT antes da entrega
def test_conexao_exclusiva_e_entrega_depois_do_commit_com_instantes_persistidos(pg_app, pg_schema):
    delivery = GatedDelivery()
    app = pg_app(delivery=delivery)
    registry = app.state.recovery.registry
    api_checkouts: list[str] = []
    event.listen(app.state.auth.engine, "checkout", lambda *a: api_checkouts.append(threading.current_thread().name))
    seen: dict = {}

    def on_send(message):
        seen["open_connections"] = registry.open_connections        # nenhuma conexão SQL durante o envio
        seen["backends"] = worker_backends(pg_schema)
        with pg_schema.connect() as c:                               # OUTRA conexão: só vê o que foi confirmado
            seen["row"] = c.execute(select(password_reset_tokens).where(
                password_reset_tokens.c.token_hash == hash_opaque_token(message.token))).one()

    delivery.on_send = on_send
    with TestClient(app) as client:
        register(client)
        assert post_forgot(client).status_code == 202
        drain(app)
    message = delivery.messages[0]
    assert seen["open_connections"] == 0 and seen["backends"] == []
    assert seen["row"].expires_at == message.expires_at and seen["row"].created_at == message.issued_at
    assert delivery.threads == [WORKER_THREAD_NAME]
    assert WORKER_THREAD_NAME not in api_checkouts                    # o pool da API nunca é usado pelo worker
    assert type(app.state.recovery.worker_engine.pool).__name__ == "NullPool"
    assert worker_backends(pg_schema) == [] and registry.open_connections == 0


def test_caminho_publico_sem_banco_instrumentado_por_contexto_da_requisicao(pg_app):
    """Os DOIS engines (pool da API e exclusivo do worker) registram qualquer conexão ou comando feito
    dentro do contexto da requisição de `forgot-password`. Manutenção oportunista desligada: é um job
    pós-resposta já existente (P5), sem relação com este caminho."""
    in_request: contextvars.ContextVar[bool] = contextvars.ContextVar("in_request", default=False)
    touched: list[str] = []
    delivery = CapturingDelivery()
    app = pg_app(delivery=delivery, MAINTENANCE_OPPORTUNISTIC_ENABLED="false")

    @app.middleware("http")
    async def mark(request, call_next):
        token = in_request.set(request.url.path.endswith("/forgot-password"))
        try:
            return await call_next(request)
        finally:
            in_request.reset(token)

    for label, engine in (("api", app.state.auth.engine), ("worker", app.state.recovery.worker_engine)):
        for name in ("connect", "checkout"):
            event.listen(engine.pool, name, lambda *a, _l=f"{label}:{name}": touched.append(_l)
                         if in_request.get() else None)
        event.listen(engine, "before_cursor_execute", lambda *a, _l=f"{label}:sql", **k: touched.append(_l)
                     if in_request.get() else None)
    with TestClient(app) as client:
        register(client)
        assert post_forgot(client).status_code == 202
        assert post_forgot(client, "ninguem@exemplo.com").status_code == 202
        drain(app)
    assert touched == []
    assert len(delivery.messages) == 1 and dispatcher(app).counter("unknown_user") == 1


# ------------------------------------------------------------------ encerramento durante SQL
@pytest.mark.skipif(not cancel_with_timeout_supported(), reason="cliente sem cancelamento com timeout (libpq < 17)")
def test_encerramento_durante_sql_cancela_so_a_conexao_do_worker(pg_app, pg_schema):
    delivery = CapturingDelivery()
    app = pg_app(delivery=delivery, DATABASE_LOCK_TIMEOUT_MS="20000", DATABASE_STATEMENT_TIMEOUT_MS="30000",
                 RECOVERY_SHUTDOWN_GRACE_SECONDS="5", **LONG_DB)
    registry = app.state.recovery.registry
    assert registry.capability is True
    client = TestClient(app)
    client.__enter__()
    try:
        register(client)
        uid = user_id(pg_schema)
        with control_connection(pg_schema) as holder:
            holder.execute(select(users.c.id).where(users.c.id == uid).with_for_update())
            holder_pid = backend_pid(holder)

            def alien_query():                                         # consulta ALHEIA, pelo pool da API
                with app.state.auth.engine.connect() as c:
                    c.execute(select(users.c.id).where(users.c.id == uid).with_for_update())
                    c.rollback()
                return "ok"

            alien = Runner(alien_query)
            alien.start()
            alien_pid = wait_for_lock_waiter(pg_schema, blocked_by=holder_pid)
            assert post_forgot(client).status_code == 202
            worker_pid = wait_worker_waiting_lock(pg_schema, holder_pid)
            assert worker_pid != alien_pid
            started = time.monotonic()
            state = app.state.recovery.stop()
            elapsed = time.monotonic() - started
            assert state is DispatcherState.STOPPED_CLEAN and elapsed < 5
            assert registry.cancel_requests >= 1 and registry.open_connections == 0
            assert worker_backends(pg_schema) == []                    # conexão exclusiva FECHADA
            assert is_waiting(pg_schema, alien_pid)                    # a consulta alheia NÃO foi cancelada
            holder.rollback()                                          # libera
        alien.join(WAIT)
        assert alien.error is None and alien.result == "ok"
    finally:
        client.__exit__(None, None, None)
    assert token_rows(pg_schema) == 0 and delivery.messages == []     # rollback: nenhum token
    assert dispatcher(app).counter("issue_failed") == 1


def test_sem_capacidade_nao_cancela_e_encerramento_e_nao_limpo(pg_app, pg_schema):
    """Capacidade AUSENTE (simulada por injeção; o cliente real tem libpq 18): nenhum cancelamento ativo,
    nem bloqueante. O lifespan retorna no orçamento com `stopped_unclean`; o comando continua até seus
    próprios limites. Corrida documentada: a emissão confirmada depois disso não é enviada."""
    delivery = CapturingDelivery()
    app = pg_app(delivery=delivery, recovery_overrides={"cancel_capability": False},
                 RECOVERY_SHUTDOWN_GRACE_SECONDS="1", **LONG_DB)
    registry = app.state.recovery.registry
    client = TestClient(app)
    client.__enter__()
    try:
        register(client)
        uid = user_id(pg_schema)
        with control_connection(pg_schema) as holder:
            holder.execute(select(users.c.id).where(users.c.id == uid).with_for_update())
            assert post_forgot(client).status_code == 202
            worker_pid = wait_worker_waiting_lock(pg_schema, backend_pid(holder))
            started = time.monotonic()
            client.__exit__(None, None, None)                          # lifespan: stop + dispose do pool da API
            elapsed = time.monotonic() - started
            assert dispatcher(app).state is DispatcherState.STOPPED_UNCLEAN and elapsed < 1.5
            assert registry.cancel_requests == 0
            assert is_waiting(pg_schema, worker_pid)                   # nada foi cancelado
            holder.rollback()
    finally:
        for t in [t for t in threading.enumerate() if t.name == WORKER_THREAD_NAME]:
            t.join(WAIT)
    assert registry.open_connections == 0 and worker_backends(pg_schema) == []
    assert delivery.messages == []                                     # parada reconhecida antes da entrega
    assert dispatcher(app).counter("stopped_after_issue") == 1 and token_rows(pg_schema) == 1


def test_registro_em_liberacao_nao_recebe_cancelamento(pg_app, pg_schema):
    gate = StageGate("recovery:withdrawn")
    app = pg_app(delivery=CapturingDelivery(), recovery_overrides={"registry_hook": gate})
    registry = app.state.recovery.registry
    with TestClient(app) as client:
        assert post_forgot(client, "ninguem@exemplo.com").status_code == 202
        assert gate.reached.wait(WAIT)                                 # LIBERANDO feito; conexão ainda aberta
        try:
            assert registry.active is False and registry.open_connections == 1
            assert registry.cancel_active(Deadline(1.0)) is CancelOutcome.NO_ACTIVE   # sem propriedade: nada
            assert registry.cancel_requests == 0
        finally:
            gate.release.set()
        drain(app)
    assert registry.open_connections == 0


def test_capacidade_de_cancelamento_e_verificada_e_registrada(pg_app, caplog):
    expected = psycopg.pq.version() >= 170000 and hasattr(psycopg.Connection, "cancel_safe")
    assert cancel_with_timeout_supported() is expected
    with caplog.at_level("INFO"):
        app = pg_app(delivery=CapturingDelivery())
        with TestClient(app):
            pass
    assert f"cancel_with_timeout={str(expected).lower()}" in caplog.text


# ------------------------------------------------------------------ reinício e redefinição
def test_pendencias_sao_perdidas_e_contadas_no_encerramento_e_nada_reaparece_ao_reiniciar(pg_app, pg_schema):
    delivery = GatedDelivery(pause_at=1)
    app = pg_app(delivery=delivery)
    client = TestClient(app)
    client.__enter__()
    try:
        register(client)
        register(client, email="bia@exemplo.com")
        assert post_forgot(client).status_code == 202
        assert delivery.reached.wait(WAIT)
        assert post_forgot(client, "bia@exemplo.com").status_code == 202
        stopper = threading.Thread(target=client.__exit__, args=(None, None, None))
        stopper.start()
        assert dispatcher(app).wait_state(DispatcherState.STOPPING, WAIT)
        assert dispatcher(app).counter("shutdown_discarded") == 1
    finally:
        delivery.release.set()
    stopper.join(WAIT)
    assert dispatcher(app).state is DispatcherState.STOPPED_CLEAN
    app2 = pg_app(delivery=CapturingDelivery())
    with TestClient(app2):
        assert dispatcher(app2).snapshot()["queued"] == 0              # fila em memória: nada sobrevive
    with pg_schema.connect() as c:
        owners = c.execute(select(users.c.email).join(password_reset_tokens,
                                                      password_reset_tokens.c.user_id == users.c.id)).scalars().all()
    assert owners == [EMAIL]                                           # bia nunca recebeu token
    assert [m.email for m in delivery.messages] == [EMAIL]


def test_pedido_pendente_atravessa_redefinicao_no_postgres(pg_app, pg_schema):
    delivery = GatedDelivery(pause_at=2)
    app = pg_app(delivery=delivery)
    with TestClient(app) as client:
        register(client)
        register(client, email="bia@exemplo.com")
        assert post_forgot(client).status_code == 202
        drain(app)
        first = delivery.messages[0].token
        assert post_forgot(client, "bia@exemplo.com").status_code == 202
        assert delivery.reached.wait(WAIT)
        assert post_forgot(client).status_code == 202                  # ana: pendente na fila
        body = {"token": first, "newPassword": "Nova-senha-1234"}
        assert client.post(f"{API}/auth/reset-password", json=body).status_code == 204
        delivery.release.set()
        drain(app)
        latest = delivery.messages[-1]
        assert latest.email == EMAIL and latest.token != first          # emitido DEPOIS da redefinição
        body = {"token": latest.token, "newPassword": "Outra-senha-5678"}
        assert client.post(f"{API}/auth/reset-password", json=body).status_code == 204
    with pg_schema.connect() as c:
        assert c.execute(select(users.c.credential_version).where(users.c.email == EMAIL)).scalar_one() == 2
