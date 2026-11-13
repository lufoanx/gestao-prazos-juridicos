"""P5 — manutenção global com PostgreSQL real: retenção, fronteiras exatas, bloqueios, falhas,
limites, concorrência e devolução de conexões. Gates e observação de bloqueios; sem sleeps."""
from __future__ import annotations

import uuid
from dataclasses import replace

import pytest
from sqlalchemy import select, text

from app.db.tables import (
    auth_sessions,
    auth_used_refresh_hashes,
    intimation_events,
    intimations,
    notifications,
)
from app.maintenance import run_maintenance
from tests.auth_sql_support import Gates, Runner, backend_pid, control_connection, wait_for_lock_waiter
from tests.conftest import FakeClock
from tests.maintenance_support import (
    DAY,
    LIMITS,
    POLICY,
    T0,
    deadline_with_children,
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
EPS = 1e-6


def clock_at(moment) -> FakeClock:
    c = FakeClock()
    c.advance((moment - c.now()).total_seconds())
    return c


def count(engine, table: str, where: str = "true") -> int:
    with engine.connect() as c:
        return c.execute(text(f"SELECT count(*) FROM prazoai.{table} WHERE {where}")).scalar_one()


def exists(engine, table, row_id) -> bool:
    pk = table.c.id if "id" in table.c else table.c.token_hash
    with engine.connect() as c:
        return c.execute(select(pk).where(pk == row_id)).first() is not None


def run(engine, moment, **kw):
    return run_maintenance(engine, clock_at(moment), POLICY, kw.pop("limits", LIMITS), **kw)


@pytest.fixture
def world(pg_schema):
    with pg_schema.begin() as c:
        owner = user(c)
        member = user(c)
        o = office(c, owner)
    return pg_schema, owner, member, o


# ---------------------------------------------------------------- políticas e fronteiras exatas
def test_sessoes_expiradas_saem_com_hashes_e_revogada_valida_fica(world):
    engine, owner, member, o = world
    with engine.begin() as c:
        expired = session(c, owner, expires=T0)
        revoked_valid = session(c, owner, expires=T0 + DAY, revoked=T0 - DAY)
        active = session(c, member, expires=T0 + DAY)
    r = run(engine, T0 - EPS * __import__("datetime").timedelta(seconds=1), categories=("sessions",))
    assert r.removed.get("sessions", 0) == 0 and exists(engine, auth_sessions, expired)      # antes da fronteira
    r = run(engine, T0, categories=("sessions",))                                           # instante EXATO
    assert r.removed == {"sessions": 1, "used_refresh_hashes": 2} and not r.interrupted
    assert not exists(engine, auth_sessions, expired)
    assert count(engine, "auth_used_refresh_hashes", f"session_id = '{expired}'") == 0
    assert exists(engine, auth_sessions, revoked_valid) and exists(engine, auth_sessions, active)
    assert count(engine, "auth_used_refresh_hashes", f"session_id = '{revoked_valid}'") == 2   # histórico mantido


def test_tokens_de_recuperacao_usados_invalidados_ou_expirados(world):
    engine, owner, member, o = world
    with engine.begin() as c:
        used = reset(c, owner, expires=T0 + DAY, used=T0 - DAY)
        invalidated = reset(c, member, expires=T0 + DAY, invalidated=T0 - DAY)
        expiring = reset(c, user(c), expires=T0)
        active = reset(c, user(c), expires=T0 + DAY)
    from app.db.tables import password_reset_tokens as prt

    run(engine, T0 - DAY / 2, categories=("password_reset_tokens",))
    assert exists(engine, prt, expiring)                                       # ainda não expirou
    r = run(engine, T0, categories=("password_reset_tokens",))
    assert r.removed.get("password_reset_tokens", 0) == 1 and not exists(engine, prt, expiring)
    assert not exists(engine, prt, used) and not exists(engine, prt, invalidated) and exists(engine, prt, active)


def test_convites_por_encerramento_ou_expiracao_na_fronteira(world):
    engine, owner, member, o = world
    from app.db.tables import invitations as inv

    with engine.begin() as c:
        revoked = invitation(c, o, owner, status="revoked", expires=T0 + 99 * DAY, closed=T0 - 10 * DAY)
        accepted_recent = invitation(c, o, owner, status="accepted", expires=T0 - 50 * DAY, closed=T0 - 9 * DAY)
        expired = invitation(c, o, owner, expires=T0 - 10 * DAY)                # pendente expirado há 10 dias
        expired_recent = invitation(c, o, owner, expires=T0 - 9 * DAY)
        valid = invitation(c, o, owner, expires=T0 + DAY)
    run(engine, T0 - __import__("datetime").timedelta(microseconds=1), categories=("invitations",))
    assert exists(engine, inv, revoked) and exists(engine, inv, expired)        # 1 µs antes: ficam
    r = run(engine, T0, categories=("invitations",))
    assert r.removed == {"invitations": 2}
    assert not exists(engine, inv, revoked) and not exists(engine, inv, expired)
    # referência certa: aceito há 9 dias (embora expirado há 50) e pendente expirado há 9 dias FICAM
    assert exists(engine, inv, accepted_recent) and exists(engine, inv, expired_recent) and exists(engine, inv, valid)


def test_solicitacoes_decididas_apos_retencao(world):
    engine, owner, member, o = world
    from app.db.tables import join_requests as jr

    with engine.begin() as c:
        old = request(c, o, member, status="rejected", decided=T0 - 10 * DAY)
        recent = request(c, o, user(c), status="cancelled", decided=T0 - 10 * DAY + DAY / 24)
        pending = request(c, o, user(c))
    run(engine, T0 - __import__("datetime").timedelta(microseconds=1), categories=("join_requests",))
    assert exists(engine, jr, old)
    r = run(engine, T0, categories=("join_requests",))
    assert r.removed == {"join_requests": 1} and not exists(engine, jr, old)
    assert exists(engine, jr, recent) and exists(engine, jr, pending)


def test_intimacao_descartada_sai_com_eventos_e_notificacoes(world):
    engine, owner, member, o = world
    with engine.begin() as c:
        gone = intimation(c, o, owner, status="discarded", closed=T0 - 10 * DAY, events=3)
        n1 = notification(c, member, o, gone)
        recent = intimation(c, o, owner, status="discarded", closed=T0 - 9 * DAY)
        pending = intimation(c, o, owner)
        n2 = notification(c, member, o, pending)
    run(engine, T0 - __import__("datetime").timedelta(microseconds=1), categories=("intimations_discarded",))
    assert exists(engine, intimations, gone)
    r = run(engine, T0, categories=("intimations_discarded",))
    assert r.removed == {"intimations_discarded": 1, "intimation_events": 3, "intimation_notifications": 1}
    assert not exists(engine, intimations, gone) and not exists(engine, notifications, n1)
    assert count(engine, "intimation_events", f"intimation_id = '{gone}'") == 0
    assert exists(engine, intimations, recent) and exists(engine, intimations, pending)
    assert exists(engine, notifications, n2)


def test_notificacoes_lidas_apos_retencao_e_nao_lidas_ficam(world):
    engine, owner, member, o = world
    with engine.begin() as c:
        i = intimation(c, o, owner)
        old = notification(c, member, o, i, read=T0 - 10 * DAY)
        recent = notification(c, member, o, i, read=T0 - 9 * DAY)
        unread = notification(c, member, o, i)
    run(engine, T0 - __import__("datetime").timedelta(microseconds=1), categories=("notifications_read",))
    assert exists(engine, notifications, old)
    r = run(engine, T0, categories=("notifications_read",))
    assert r.removed == {"notifications_read": 1}
    assert exists(engine, notifications, recent) and exists(engine, notifications, unread)


def test_dados_permanentes_nunca_expurgados_por_idade(world):
    engine, owner, member, o = world
    with engine.begin() as c:
        deadline_with_children(c, o, owner)
    before = {t: count(engine, t) for t in ("users", "offices", "memberships", "deadlines", "deadline_comments",
                                            "deadline_history")}
    r = run(engine, T0 + 3650 * DAY)                                       # dez anos depois, todas as categorias
    assert not r.interrupted
    assert {t: count(engine, t) for t in before} == before


# ---------------------------------------------------------------- bloqueios
def test_linha_bloqueada_e_pulada_sem_espera_e_removida_depois(world):
    engine, owner, member, o = world
    with engine.begin() as c:
        i = intimation(c, o, owner)
        locked = notification(c, member, o, i, read=T0 - 20 * DAY)
        free = notification(c, member, o, i, read=T0 - 20 * DAY)
    with control_connection(engine) as holder:
        holder.execute(select(notifications.c.id).where(notifications.c.id == locked).with_for_update())
        r = run(engine, T0, categories=("notifications_read",))            # não espera (SKIP LOCKED)
        assert r.removed == {"notifications_read": 1} and not r.interrupted
        assert exists(engine, notifications, locked) and not exists(engine, notifications, free)
    r = run(engine, T0, categories=("notifications_read",))                # execução futura
    assert r.removed == {"notifications_read": 1} and not exists(engine, notifications, locked)


def test_filho_bloqueado_impede_exclusao_parcial_do_conjunto(world):
    engine, owner, member, o = world
    with engine.begin() as c:
        blocked = intimation(c, o, owner, status="discarded", closed=T0 - 20 * DAY, events=2)
        ok = intimation(c, o, owner, status="discarded", closed=T0 - 20 * DAY, events=2)
    with engine.connect() as c:
        child = c.execute(select(intimation_events.c.id).where(intimation_events.c.intimation_id == blocked)
                          .limit(1)).scalar_one()
    with control_connection(engine) as holder:
        holder.execute(select(intimation_events.c.id).where(intimation_events.c.id == child).with_for_update())
        r = run(engine, T0, categories=("intimations_discarded",))
        assert r.skipped_locked == 1 and r.removed.get("intimations_discarded") == 1
        assert exists(engine, intimations, blocked)                          # pai não foi apagado por cascata
        assert count(engine, "intimation_events", f"intimation_id = '{blocked}'") == 2   # nenhum filho apagado
        assert not exists(engine, intimations, ok)
    r = run(engine, T0, categories=("intimations_discarded",))
    assert r.removed.get("intimations_discarded") == 1 and not exists(engine, intimations, blocked)


# ---------------------------------------------------------------- falhas e rollback do lote
def test_falha_injetada_depois_dos_filhos_desfaz_o_lote_e_preserva_lotes_anteriores(world):
    engine, owner, member, o = world
    with engine.begin() as c:
        i = intimation(c, o, owner)
        for _ in range(3):
            notification(c, member, o, i, read=T0 - 20 * DAY)
        gone = intimation(c, o, owner, status="discarded", closed=T0 - 20 * DAY, events=2)

    def fail(name):
        if name == "maintenance:intimations_discarded:after_children":
            raise RuntimeError("falha injetada")

    r = run(engine, T0, checkpoint=fail)
    assert r.interrupted and r.failure == "error" and r.failed_category == "intimations_discarded"
    assert r.removed == {"notifications_read": 3}                           # lote anterior confirmado e contado
    assert exists(engine, intimations, gone)                               # lote atual desfeito por inteiro
    assert count(engine, "intimation_events", f"intimation_id = '{gone}'") == 2
    assert engine.pool.checkedout() == 0


def test_lock_timeout_interrompe_desfaz_o_lote_e_para_a_execucao(world):
    engine, owner, member, o = world
    with engine.begin() as c:
        i = intimation(c, o, owner)
        notification(c, member, o, i, read=T0 - 20 * DAY)
        request(c, o, member, status="rejected", decided=T0 - 20 * DAY)
        reset(c, owner, expires=T0 - DAY)
    with control_connection(engine) as holder:
        holder.execute(text("LOCK TABLE prazoai.join_requests IN ACCESS EXCLUSIVE MODE"))   # SKIP LOCKED não basta
        r = run(engine, T0)
    assert r.interrupted and r.failure == "lock_timeout" and r.failed_category == "join_requests"
    assert r.removed == {"notifications_read": 1}                           # anterior confirmado
    assert count(engine, "join_requests") == 1 and count(engine, "password_reset_tokens") == 1   # nada depois
    assert engine.pool.checkedout() == 0
    r = run(engine, T0)                                                     # nova tentativa: execução futura
    assert not r.interrupted and r.removed == {"join_requests": 1, "password_reset_tokens": 1}


# ---------------------------------------------------------------- limites
def test_limites_de_lote_e_de_trabalho_por_execucao(world):
    engine, owner, member, o = world
    with engine.begin() as c:
        i = intimation(c, o, owner)
        for _ in range(10):
            notification(c, member, o, i, read=T0 - 20 * DAY)
    limits = replace(LIMITS, batch_size=2, max_batches=3)
    r = run(engine, T0, limits=limits)
    assert r.removed == {"notifications_read": 6} and r.batches == 3 and r.limit_reached and not r.interrupted
    assert count(engine, "notifications") == 4


# ---------------------------------------------------------------- concorrência
def test_duas_manutencoes_concorrentes_nao_duplicam_nem_esperam(world):
    engine, owner, member, o = world
    with engine.begin() as c:
        i = intimation(c, o, owner)
        for _ in range(8):
            notification(c, member, o, i, read=T0 - 20 * DAY)
    gates = Gates()
    gates.pause_at("maintenance:notifications_read:locked")
    limits = replace(LIMITS, batch_size=4)
    first = Runner(run, engine, T0, limits=limits, categories=("notifications_read",), checkpoint=gates)
    first.start()
    gates.wait_reached("maintenance:notifications_read:locked")             # 1ª segura 4 linhas
    second = run(engine, T0, limits=limits, categories=("notifications_read",))   # pula as travadas
    gates.release("maintenance:notifications_read:locked")
    r1 = first.join_result()
    assert r1.removed["notifications_read"] + second.removed["notifications_read"] == 8
    assert count(engine, "notifications") == 0


def test_manutencao_nao_bloqueia_refresh_e_reset_de_outras_linhas(world):
    engine, owner, member, o = world
    from app.repositories.sql import SqlContext, SqlPasswordResetRepository, SqlSessionRepository
    from tests.auth_sql_support import h, new_reset

    with engine.begin() as c:
        session(c, owner, expires=T0 - DAY)                                  # expirada (alvo)
    clock = clock_at(T0)
    ctx = SqlContext(engine=engine, clock=clock)
    sessions = SqlSessionRepository(ctx, max_sessions_per_user=5, max_rotations_per_session=50)
    resets = SqlPasswordResetRepository(ctx)
    from app.domain.auth import User
    from tests.auth_sql_support import new_session
    u = User(id=member.hex, name="M", email="m@x.com", password_hash="h", created_at=T0)
    live = new_session(u, clock.now(), h("vivo"))
    assert sessions.add_if_credentials_current(live)
    gates = Gates()
    gates.pause_at("maintenance:sessions:locked")
    m = Runner(run, engine, T0, categories=("password_reset_tokens", "sessions"), checkpoint=gates)
    m.start()
    gates.wait_reached("maintenance:sessions:locked")                       # manutenção segura a expirada
    assert sessions.rotate_refresh(h("vivo"), h("novo"), clock.now())[0].value == "rotated"   # sem espera
    resets.issue_replacing_active(new_reset(u, clock.now(), h("r")), clock.now())
    assert resets.complete_reset(h("r"), "nova-senha", clock.now()) == member.hex             # sem espera
    gates.release("maintenance:sessions:locked")
    r = m.join_result()
    assert r.removed.get("sessions") == 1 and not r.interrupted


def test_alteracao_de_dominio_concorrente_preserva_a_linha_em_uso(world):
    engine, owner, member, o = world
    with engine.begin() as c:
        i = intimation(c, o, owner)
        n = notification(c, member, o, i, read=T0 - 20 * DAY)
    with control_connection(engine) as writer:                              # operação de domínio em curso
        writer.execute(text("UPDATE prazoai.notifications SET read_at = :t WHERE id = :n"),
                       {"t": T0, "n": n})                                   # lida "agora": sai da retenção
        r = run(engine, T0, categories=("notifications_read",))
        assert r.removed.get("notifications_read", 0) == 0                  # linha em uso pulada
        writer.commit()
    r = run(engine, T0, categories=("notifications_read",))
    assert r.removed.get("notifications_read", 0) == 0 and exists(engine, notifications, n)   # revalidada: fica


def test_conexoes_devolvidas_ao_pool_em_todos_os_caminhos(world):
    engine, *_ = world
    run(engine, T0)
    run(engine, T0, checkpoint=lambda n: (_ for _ in ()).throw(RuntimeError("x")))
    assert engine.pool.checkedout() == 0
    _ = (uuid, auth_used_refresh_hashes, backend_pid, wait_for_lock_waiter)
