"""P5 — execução oportunista, comando explícito e startup, com PostgreSQL real.

Inclui os equivalentes SQL dos testes de retenção marcados `memory_only` na P4."""
from __future__ import annotations

import json
import os
import subprocess
import sys
import threading
from datetime import timedelta
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

from tests.auth_sql_support import Gates, Runner, control_connection
from tests.conftest import FakeClock
from tests.maintenance_support import DAY, POLICY, T0, intimation, notification, office, request, user
from tests.org_utils import API, OrgClient, fast_hasher

pytestmark = pytest.mark.postgres
BACKEND = Path(__file__).resolve().parents[1]


def count(engine, table: str, where: str = "true") -> int:
    with engine.connect() as c:
        return c.execute(text(f"SELECT count(*) FROM prazoai.{table} WHERE {where}")).scalar_one()


# ---------------------------------------------------------------- execução oportunista
def _scheduler(engine, clock, interval=300, checkpoint=None):
    from app.maintenance import MaintenanceLimits
    from app.maintenance.opportunistic import OpportunisticMaintenance

    return OpportunisticMaintenance(engine, clock, POLICY, MaintenanceLimits(batch_size=10, max_batches=2),
                                    interval, checkpoint=checkpoint)


def test_no_maximo_uma_execucao_por_intervalo_sob_concorrencia(pg_schema):
    clock = FakeClock()
    s = _scheduler(pg_schema, clock)
    barrier = threading.Barrier(12)
    claims: list[bool] = []

    def claim():
        barrier.wait()                                                     # todas ao mesmo tempo
        claims.append(s.try_claim())

    threads = [threading.Thread(target=claim) for _ in range(12)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(10)
    assert claims.count(True) == 1                                         # uma única reivindicação
    s.run_claimed()
    assert s.try_claim() is False                                         # mesmo intervalo
    clock.advance(299)
    assert s.try_claim() is False
    clock.advance(1)                                                       # fronteira exata do intervalo
    assert s.try_claim() is True
    s.run_claimed()
    assert s.runs == 2


def test_execucao_em_curso_impede_outra_mesmo_com_intervalo_vencido(pg_schema):
    clock, gates = FakeClock(), Gates()
    gates.pause_at("maintenance:notifications_read:locked")
    s = _scheduler(pg_schema, clock, interval=10, checkpoint=gates)
    t = Runner(s.maybe_run)
    t.start()
    gates.wait_reached("maintenance:notifications_read:locked")
    clock.advance(3600)
    assert s.try_claim() is False                                          # ainda em execução
    gates.release("maintenance:notifications_read:locked")
    t.join_result()
    assert s.try_claim() is True


def test_falha_da_manutencao_nao_altera_resultado_de_negocio(pg_app, pg_schema):
    clock = FakeClock()

    def boom(name):
        raise RuntimeError("falha injetada na manutenção")

    app = pg_app(OFFICES_ENABLED="true", password_hasher=fast_hasher(), clock=clock, maintenance_checkpoint=boom)
    o = OrgClient(app)
    ana = o.person("ana")
    r = o.http.post(f"{API}/offices", headers=ana.headers, json={"name": "Escritório"})
    assert r.status_code == 201                                            # resposta de sucesso intacta
    assert count(pg_schema, "offices") == 1                                # operação confirmada
    m = app.state.maintenance
    assert m.runs >= 1 and m.last_result.interrupted and m.last_result.failure == "error"
    assert app.state.auth.engine.pool.checkedout() == 0


def test_oportunista_roda_depois_da_resposta_e_limpa_com_limite(pg_app, pg_schema):
    clock = FakeClock()
    app = pg_app(OFFICES_ENABLED="true", password_hasher=fast_hasher(), clock=clock,
                 MAINTENANCE_OPPORTUNISTIC_MAX_BATCHES="1", MAINTENANCE_BATCH_SIZE="2")
    with pg_schema.begin() as c:
        u = user(c)
        o = office(c, u)
        i = intimation(c, o, u)
        for _ in range(5):
            notification(c, u, o, i, read=clock.now() - 200 * DAY)
    client = TestClient(app)
    assert client.get(f"{API}/health").status_code == 200
    assert app.state.maintenance.runs == 1
    assert count(pg_schema, "notifications") == 3                          # limitado a 1 lote de 2
    assert app.state.maintenance.last_result.limit_reached
    client.get(f"{API}/health")
    assert app.state.maintenance.runs == 1                                 # mesmo intervalo: não roda de novo


def test_modo_memory_nao_tem_manutencao_oportunista_sql(make_app):
    app = make_app()
    assert app.state.maintenance is None


# ---------------------------------------------------------------- equivalentes SQL dos memory_only de retenção
def test_sql_convites_e_solicitacoes_encerrados_removidos_apos_retencao(pg_app, pg_schema):
    clock = FakeClock()
    o = OrgClient(pg_app(OFFICES_ENABLED="true", password_hasher=fast_hasher(), clock=clock,
                         ORG_CLOSED_RETENTION_SECONDS=str(24 * 3600), MAINTENANCE_OPPORTUNISTIC_ENABLED="false"))
    ana, bia, caio = o.person("ana"), o.person("bia"), o.person("caio")
    oid = o.office(ana)
    o.invite(ana, oid)                                                     # pendente (expira no TTL)
    inv = next(iter(o.store.invitations.values()))
    o.http.post(f"{API}/offices/{oid}/invitations/{inv.id}/revoke", headers=ana.headers)
    code = o.http.get(f"{API}/offices/{oid}/join-code", headers=ana.headers).json()["joinCode"]
    rid = o.http.post(f"{API}/join-requests", headers=bia.headers, json={"joinCode": code}).json()["id"]
    o.http.post(f"{API}/offices/{oid}/join-requests/{rid}/reject", headers=ana.headers)
    pending = o.http.post(f"{API}/join-requests", headers=caio.headers, json={"joinCode": code}).json()["id"]
    uow = o.app.state.org.unit_of_work
    clock.advance(24 * 3600 - 1)
    assert uow.purge(clock.now()) == 0                                     # 1 s antes da retenção
    clock.advance(1)
    assert uow.purge(clock.now()) == 2                                     # convite revogado + solicitação rejeitada
    assert set(o.store.requests) == {pending} and o.store.invitations == {}


def test_sql_intimacao_descartada_removida_com_eventos_apos_retencao(pg_app, pg_schema):
    from tests.intimation_utils import register

    clock = FakeClock()
    o = OrgClient(pg_app(OFFICES_ENABLED="true", password_hasher=fast_hasher(), clock=clock,
                         INTIMATIONS_DISCARD_RETENTION_SECONDS=str(24 * 3600),
                         MAINTENANCE_OPPORTUNISTIC_ENABLED="false"))
    ana = o.person("ana")
    o.office(ana)
    i = register(o, ana)
    keep = register(o, ana)
    assert o.http.post(f"{API}/intimations/{i['id']}/discard", headers=ana.headers,
                       json={"version": 1}).status_code == 200
    uow = o.app.state.org.unit_of_work
    clock.advance(24 * 3600 - 1)
    assert uow.purge(clock.now()) == 0
    clock.advance(1)
    assert uow.purge(clock.now()) >= 1
    assert set(uow.intimation_store.intimations) == {keep["id"]}
    assert i["id"] not in uow.intimation_store.events


def test_sql_notificacoes_lidas_removidas_apos_retencao_sem_recriar(pg_app, pg_schema):
    from tests.deadline_utils import create

    clock = FakeClock()
    o = OrgClient(pg_app(OFFICES_ENABLED="true", password_hasher=fast_hasher(), clock=clock,
                         NOTIFICATIONS_READ_RETENTION_SECONDS=str(24 * 3600),
                         MAINTENANCE_OPPORTUNISTIC_ENABLED="false"))
    ana, bia = o.person("ana"), o.person("bia")
    oid = o.office(ana)
    o.join(ana, oid, bia)
    create(o, ana, responsibleId=bia.id)
    create(o, ana, responsibleId=bia.id)
    store = o.app.state.org.unit_of_work.notification_store
    first = sorted(store.notifications.values(), key=lambda n: n.id)[0]
    assert o.http.post(f"{API}/notifications/{first.id}/read", headers=bia.headers).status_code == 200
    uow = o.app.state.org.unit_of_work
    clock.advance(24 * 3600 - 1)
    assert uow.purge(clock.now()) == 0
    clock.advance(1)
    assert uow.purge(clock.now()) == 1
    assert first.id not in store.notifications and len(store.notifications) == 1
    assert (first.recipient_id, first.event_id) not in store.dedupe                # não é recriada


# ---------------------------------------------------------------- comando real
def _cmd(env_extra: dict, *args: str) -> tuple[int, dict, str]:
    env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "ENVIRONMENT": "test", **env_extra}
    out = subprocess.run([sys.executable, "-m", "app.maintenance", "purge", *args], cwd=BACKEND,
                         capture_output=True, text=True, timeout=120, env=env)
    payload = json.loads(out.stdout.strip().splitlines()[-1]) if out.stdout.strip() else {}
    return out.returncode, payload, out.stderr


def test_comando_real_codigos_de_saida_e_contagens(pg_schema, pg_url):
    from alembic import command

    from tests.conftest import alembic_config_for

    url = pg_url.render_as_string(hide_password=False)
    pg = {"STORAGE": "postgres", "DATABASE_URL": url}
    with pg_schema.begin() as c:                                           # dados vencidos (relógio real)
        u = user(c)
        o = office(c, u)
        i = intimation(c, o, u)
        for _ in range(3):
            notification(c, u, o, i, read=T0 - 400 * DAY)
        request(c, o, user(c), status="rejected", decided=T0 - 400 * DAY)
    code, out, _ = _cmd(pg, "--batch-size", "1", "--max-batches", "1")    # orçamento pequeno
    assert code == 6 and out["status"] == "partial" and out["complete"] is False and out["limitReached"] is True
    assert out["total"] == 1                                               # parcial NÃO é limpeza completa
    code, out, err = _cmd(pg, "--batch-size", "2")
    assert code == 0 and out["status"] == "ok" and out["complete"] is True
    assert out["removed"] == {"notifications_read": 2, "join_requests": 1}  # o restante do parcial anterior
    assert out["total"] == 3 and out["interrupted"] is False and pg_url.password not in (err + json.dumps(out))
    assert count(pg_schema, "notifications") == 0
    code, out, _ = _cmd({"STORAGE": "memory"})
    assert code == 3 and out["status"] == "memory_storage"
    code, out, _ = _cmd({"STORAGE": "postgres"})                            # sem DATABASE_URL
    assert code == 2 and out["status"] == "config_error"
    code, out, _ = _cmd({**pg, "ENVIRONMENT": "production", "AUTH_JWT_SECRET": "s" * 48})
    assert code == 2
    with pg_schema.begin() as c:
        notification(c, u, o, i, read=T0 - 400 * DAY)
    with control_connection(pg_schema) as holder:                          # bloqueio que SKIP LOCKED não contorna
        holder.execute(text("LOCK TABLE prazoai.notifications IN ACCESS EXCLUSIVE MODE"))
        code, out, _ = _cmd(pg)
    assert code == 1 and out["status"] == "interrupted" and out["failure"] == "lock_timeout"
    assert count(pg_schema, "notifications") == 1                          # lote desfeito
    try:
        with pg_schema.begin() as c:
            command.downgrade(alembic_config_for(c), "0002")
        code, out, _ = _cmd(pg)
        assert code == 4 and out["status"] == "schema_not_ready"            # nada apagado
        assert count(pg_schema, "notifications") == 1
    finally:
        with pg_schema.begin() as c:
            command.upgrade(alembic_config_for(c), "head")


def test_comando_nao_importa_a_aplicacao_web():
    script = ("import sys, runpy; sys.argv=['x','purge']; "
              "import app.maintenance.__main__ as m; m.main(['purge']); print('app.main' in sys.modules)")
    out = subprocess.run([sys.executable, "-c", script], cwd=BACKEND, capture_output=True, text=True, timeout=60,
                         env={"PATH": os.environ.get("PATH", ""), "STORAGE": "memory"})
    assert out.stdout.strip().endswith("False")


# ---------------------------------------------------------------- startup
def test_startup_recusa_revisao_desconhecida_sem_escrita(pg_schema, pg_url, make_app):
    from app.repositories.sql import SchemaNotReadyError

    with pg_schema.begin() as c:
        c.execute(text("UPDATE prazoai.alembic_version SET version_num = '9999'"))
    try:
        before = count(pg_schema, "alembic_version", "version_num = '9999'")
        with pytest.raises(SchemaNotReadyError, match="9999"):
            make_app(STORAGE="postgres", ENVIRONMENT="test", AUTH_JWT_SECRET="s" * 48,
                     DATABASE_URL=pg_url.render_as_string(hide_password=False))
        assert count(pg_schema, "alembic_version", "version_num = '9999'") == before == 1   # nada alterado
    finally:
        with pg_schema.begin() as c:
            c.execute(text("UPDATE prazoai.alembic_version SET version_num = '0003'"))
    _ = timedelta
