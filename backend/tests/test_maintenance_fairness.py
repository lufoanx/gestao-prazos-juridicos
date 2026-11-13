"""P5 (auditoria) — justiça entre categorias na manutenção OPORTUNISTA, com PostgreSQL real.

Cada teste executa a SEQUÊNCIA REAL de execuções oportunistas (mesmo agendador, relógio avançando
um intervalo entre elas, cursor carregado de uma execução para a seguinte), sem escolher categorias
manualmente. Coordenação determinística; sem sleeps.
"""
from __future__ import annotations

import threading
from dataclasses import replace

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

from tests.conftest import FakeClock
from tests.maintenance_support import (
    DAY,
    LIMITS,
    POLICY,
    intimation,
    invitation,
    notification,
    office,
    request,
    reset,
    session,
    user,
)

pytestmark = pytest.mark.postgres
INTERVAL = 300
TABLE_OF = {"notifications_read": "notifications", "intimations_discarded": "intimations",
            "invitations": "invitations", "join_requests": "join_requests",
            "password_reset_tokens": "password_reset_tokens", "sessions": "auth_sessions"}


def count(engine, table, where="true") -> int:
    with engine.connect() as c:
        return c.execute(text(f"SELECT count(*) FROM prazoai.{table} WHERE {where}")).scalar_one()


def scheduler(engine, clock, max_batches, batch_size=1, checkpoint=None):
    from app.maintenance.opportunistic import OpportunisticMaintenance

    return OpportunisticMaintenance(engine, clock, POLICY,
                                    replace(LIMITS, batch_size=batch_size, max_batches=max_batches),
                                    INTERVAL, checkpoint=checkpoint)


def tick(s, clock) -> bool:
    """Uma 'requisição': tenta a execução oportunista e avança o relógio um intervalo."""
    ran = s.try_claim()
    if ran:
        s.run_claimed()
    clock.advance(INTERVAL)
    return ran


def seed_expired(c, now, *, per_category=1):
    """Pendências vencidas em TODAS as categorias (e dados ativos que devem ficar)."""
    u = user(c)
    o = office(c, u)
    live = intimation(c, o, u)
    for _ in range(per_category):
        notification(c, u, o, live, read=now - 30 * DAY)
        intimation(c, o, u, status="discarded", closed=now - 30 * DAY, events=1)
        invitation(c, o, u, status="revoked", expires=now + DAY, closed=now - 30 * DAY)
        request(c, o, user(c), status="rejected", decided=now - 30 * DAY)
        reset(c, user(c), expires=now - DAY)                         # um token ativo por usuário
        session(c, user(c), expires=now - DAY)
    session(c, u, expires=now + 30 * DAY, revoked=now - DAY)        # revogada ainda válida: FICA
    return u


def pending(engine, now) -> dict[str, int]:
    return {
        "notifications_read": count(engine, "notifications", "read_at IS NOT NULL"),
        "intimations_discarded": count(engine, "intimations", "status = 'discarded'"),
        "invitations": count(engine, "invitations", "status <> 'pending'"),
        "join_requests": count(engine, "join_requests", "status <> 'pending'"),
        "password_reset_tokens": count(engine, "password_reset_tokens"),
        "sessions": count(engine, "auth_sessions", "revoked_at IS NULL"),
    }


# 1 ---------------------------------------------------------------------------------------------
def test_quatro_iniciais_vazias_tokens_e_sessoes_sao_alcancados(pg_schema):
    clock = FakeClock()
    with pg_schema.begin() as c:
        u = user(c)
        reset(c, u, expires=clock.now() - DAY)
        reset(c, u, expires=clock.now() - DAY, used=clock.now() - 2 * DAY)
        session(c, user(c), expires=clock.now() - DAY)
        keep = session(c, u, expires=clock.now() + 30 * DAY, revoked=clock.now() - DAY)
    s = scheduler(pg_schema, clock, max_batches=4, batch_size=200)
    s.cursor = 0                                                     # pior caso: começa pela 1ª categoria
    tick(s, clock)
    r = s.last_result
    assert r.removed == {"password_reset_tokens": 2, "sessions": 1, "used_refresh_hashes": 2}
    assert r.empty_checks >= 4 and r.batches == 2 and r.complete    # sondagens vazias não gastaram o orçamento
    assert count(pg_schema, "password_reset_tokens") == 0
    assert count(pg_schema, "auth_sessions") == 1                    # só a revogada ainda válida…
    assert count(pg_schema, "auth_used_refresh_hashes", f"session_id = '{keep}'") == 2   # …com seus hashes


# 2 ---------------------------------------------------------------------------------------------
@pytest.mark.parametrize("budget", [1, 4])
def test_todas_as_categorias_atendidas_em_numero_finito_de_execucoes(pg_schema, budget):
    clock = FakeClock()
    with pg_schema.begin() as c:
        seed_expired(c, clock.now(), per_category=3)                 # 3 pendências por categoria
    s = scheduler(pg_schema, clock, max_batches=budget, batch_size=1)
    s.cursor = 0
    served: set[str] = set()
    bound = 6 * 3 // budget + 6                                      # limite finito e explícito
    for _ in range(bound):
        tick(s, clock)
        served |= {k for k, v in s.last_result.removed.items() if v}
        assert s.last_result.batches <= budget                       # orçamento respeitado em TODA execução
        if all(v == 0 for v in pending(pg_schema, clock.now()).values()):
            break
    assert all(v == 0 for v in pending(pg_schema, clock.now()).values()), pending(pg_schema, clock.now())
    assert set(TABLE_OF) <= served
    assert count(pg_schema, "auth_sessions") == 1                    # a revogada ainda válida ficou


# 3 ---------------------------------------------------------------------------------------------
def test_acumulo_continuo_na_primeira_categoria_nao_impede_as_demais(pg_schema):
    clock = FakeClock()
    with pg_schema.begin() as c:
        u = seed_expired(c, clock.now(), per_category=2)
        o = c.execute(text("SELECT office_id FROM prazoai.memberships LIMIT 1")).scalar_one()
        live = c.execute(text("SELECT id FROM prazoai.intimations WHERE status <> 'discarded' LIMIT 1")).scalar_one()
    s = scheduler(pg_schema, clock, max_batches=2, batch_size=1)
    s.cursor = 0
    for _ in range(30):
        with pg_schema.begin() as c:                                 # reabastece SEMPRE a 1ª categoria
            for _ in range(5):
                notification(c, u, o, live, read=clock.now() - 30 * DAY)
        tick(s, clock)
        others = {k: v for k, v in pending(pg_schema, clock.now()).items() if k != "notifications_read"}
        if all(v == 0 for v in others.values()):
            break
    assert all(v == 0 for v in others.values()), others              # as demais esgotaram mesmo assim
    assert count(pg_schema, "notifications", "read_at IS NOT NULL") > 0   # o acúmulo continua (é contínuo)


# 4 ---------------------------------------------------------------------------------------------
def test_falha_persistente_numa_categoria_nao_trava_as_demais_nem_entra_em_laco(pg_schema):
    clock = FakeClock()
    with pg_schema.begin() as c:
        seed_expired(c, clock.now(), per_category=2)
    failing = {"on": True, "attempts": 0}

    def checkpoint(name):
        if name == "maintenance:invitations:locked" and failing["on"]:
            failing["attempts"] += 1
            raise RuntimeError("falha injetada")

    s = scheduler(pg_schema, clock, max_batches=3, batch_size=1, checkpoint=checkpoint)
    s.cursor = 0
    for _ in range(20):
        tick(s, clock)
        r = s.last_result
        if r.interrupted:
            assert r.failed_category == "invitations" and "invitations" not in r.removed   # lote desfeito
        others = {k: v for k, v in pending(pg_schema, clock.now()).items() if k != "invitations"}
        if all(v == 0 for v in others.values()):
            break
    assert all(v == 0 for v in others.values()), others
    assert count(pg_schema, "invitations", "status <> 'pending'") == 2   # a que falha não perdeu nada parcial
    assert failing["attempts"] <= s.runs                                # no máximo 1 tentativa por execução
    failing["on"] = False                                                # falha resolvida: progresso retomado
    for _ in range(10):
        tick(s, clock)
        if count(pg_schema, "invitations", "status <> 'pending'") == 0:
            break
    assert count(pg_schema, "invitations", "status <> 'pending'") == 0
    confirmed = sum(r.removed.get("invitations", 0) for r in s.history)
    assert confirmed == 2                                                # só exclusões confirmadas contadas


# 5 ---------------------------------------------------------------------------------------------
def test_requisicoes_concorrentes_preservam_intervalo_e_execucao_unica(pg_app, pg_schema):
    clock = FakeClock()
    app = pg_app(clock=clock, MAINTENANCE_INTERVAL_SECONDS=str(INTERVAL), MAINTENANCE_OPPORTUNISTIC_MAX_BATCHES="1")
    with pg_schema.begin() as c:
        seed_expired(c, clock.now(), per_category=1)
    client = TestClient(app)
    barrier = threading.Barrier(10)
    statuses: list[int] = []

    def hit():
        barrier.wait()
        statuses.append(client.get("/api/v1/health").status_code)

    threads = [threading.Thread(target=hit) for _ in range(10)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(30)
    m = app.state.maintenance
    assert statuses == [200] * 10 and m.runs == 1                       # uma única execução no intervalo
    clock.advance(INTERVAL - 1)
    client.get("/api/v1/health")
    assert m.runs == 1
    clock.advance(1)                                                     # fronteira exata do intervalo
    client.get("/api/v1/health")
    assert m.runs == 2 and m.history[0].visited != [] and m.cursor == m.history[-1].next_start
