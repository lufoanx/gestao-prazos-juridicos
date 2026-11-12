"""Concorrência REAL no PostgreSQL (conexões distintas do pool, uma thread por operação, gates).

Cada teste coordena as threads com pontos de controle (`Gates`) ou com um bloqueio segurado por
uma conexão do próprio teste, e confere o estado final lendo o banco. Nenhum dublê de banco.
"""
from __future__ import annotations

import uuid
from datetime import timedelta

import pytest
from sqlalchemy import func, select, text

from app.db.tables import auth_sessions, auth_used_refresh_hashes, password_reset_tokens, users
from app.repositories.auth import EmailAlreadyRegisteredError, RotationResult
from tests.auth_sql_support import (
    Gates,
    Runner,
    backend_pid,
    control_connection,
    h,
    new_reset,
    new_session,
    new_user,
    wait_for_lock_waiter,
)
from tests.conftest import FakeClock

pytestmark = pytest.mark.postgres


@pytest.fixture
def sql(pg_schema):
    from app.repositories.sql import SqlContext, SqlPasswordResetRepository, SqlSessionRepository, SqlUserRepository

    clock, gates = FakeClock(), Gates()
    ctx = SqlContext(engine=pg_schema, clock=clock, checkpoint=gates)

    class S:
        pass

    s = S()
    s.engine, s.clock, s.gates = pg_schema, clock, gates
    s.users = SqlUserRepository(ctx)
    s.sessions = SqlSessionRepository(ctx, max_sessions_per_user=2, max_rotations_per_session=3)
    s.resets = SqlPasswordResetRepository(ctx)
    return s


def scalar(engine, stmt):
    with engine.connect() as c:
        return c.execute(stmt).scalar_one()


def registered(sql):
    u = new_user()
    sql.users.add(u)
    return u


def logged(sql, u, refresh, **kw):
    s = new_session(u, sql.clock.now(), h(refresh), **kw)
    assert sql.sessions.add_if_credentials_current(s)
    return s


def issue(sql, u, tag, ttl=1800):
    sql.resets.issue_replacing_active(new_reset(u, sql.clock.now(), h(tag), ttl), sql.clock.now())


# ---------------------------------------------------------------- cadastro
def test_cadastro_simultaneo_do_mesmo_email(sql):
    sql.gates.pause_at("register:before_insert", once=True)
    a, b = new_user(email="mesmo@x.com"), new_user(email="mesmo@x.com")
    ta = Runner(sql.users.add, a)
    ta.start()
    sql.gates.wait_reached("register:before_insert")               # A dentro da transação, antes do INSERT
    tb = Runner(sql.users.add, b)
    tb.start()
    tb.join_result()                                                # B insere e confirma (A ainda não inseriu)
    sql.gates.release("register:before_insert")
    with pytest.raises(EmailAlreadyRegisteredError):                # A esbarra na UNIQUE ao inserir
        ta.join_result()
    assert scalar(sql.engine, select(func.count()).select_from(users)) == 1


# ---------------------------------------------------------------- login × reset
def test_reset_antes_do_login_revalidar_recusa_a_sessao(sql):
    u = registered(sql)
    issue(sql, u, "r")
    sql.gates.pause_at("reset:locked")
    tr = Runner(sql.resets.complete_reset, h("r"), "hash-novo", sql.clock.now())
    tr.start()
    sql.gates.wait_reached("reset:locked")                          # reset segura users FOR UPDATE
    tl = Runner(sql.sessions.add_if_credentials_current, new_session(u, sql.clock.now(), h("s")))  # versão 0
    tl.start()
    wait_for_lock_waiter(sql.engine)                                # o PostgreSQL mostra a espera
    sql.gates.release("reset:locked")
    assert tr.join_result() == u.id
    assert tl.join_result() is False                                # versão mudou → nenhuma sessão
    assert scalar(sql.engine, select(func.count()).select_from(auth_sessions)) == 0


def test_login_antes_do_reset_tem_a_sessao_revogada(sql):
    u = registered(sql)
    issue(sql, u, "r")
    sql.gates.pause_at("login:locked")
    session = new_session(u, sql.clock.now(), h("s"))
    tl = Runner(sql.sessions.add_if_credentials_current, session)
    tl.start()
    sql.gates.wait_reached("login:locked")
    tr = Runner(sql.resets.complete_reset, h("r"), "hash-novo", sql.clock.now())
    tr.start()
    wait_for_lock_waiter(sql.engine)                                # o PostgreSQL mostra a espera
    sql.gates.release("login:locked")
    assert tl.join_result() is True
    assert tr.join_result() == u.id
    assert sql.sessions.get(session.id).revoked is True             # o reset alcançou a sessão nova


def test_rehash_nao_sobrescreve_senha_redefinida(sql):
    u = registered(sql)
    issue(sql, u, "r")
    sql.gates.pause_at("rehash:before_update")
    th = Runner(sql.users.update_password_hash_if_version, u.id, "rehash-da-senha-antiga", 0)
    th.start()
    sql.gates.wait_reached("rehash:before_update")
    assert sql.resets.complete_reset(h("r"), "senha-redefinida", sql.clock.now()) == u.id
    sql.gates.release("rehash:before_update")
    assert th.join_result() is False
    after = sql.users.get_by_id(u.id)
    assert (after.password_hash, after.credential_version) == ("senha-redefinida", 1)


# ---------------------------------------------------------------- refresh × reset
def test_refresh_antes_do_reset(sql):
    u = registered(sql)
    s = logged(sql, u, 1)
    issue(sql, u, "r")
    sql.gates.pause_at("rotate:locked")
    tf = Runner(sql.sessions.rotate_refresh, h(1), h(2), sql.clock.now())
    tf.start()
    sql.gates.wait_reached("rotate:locked")                         # users FOR SHARE + sessão FOR UPDATE
    tr = Runner(sql.resets.complete_reset, h("r"), "x", sql.clock.now())
    tr.start()
    wait_for_lock_waiter(sql.engine)                                # o PostgreSQL mostra a espera
    sql.gates.release("rotate:locked")
    assert tf.join_result()[0] is RotationResult.ROTATED
    assert tr.join_result() == u.id
    assert sql.sessions.get(s.id).revoked is True                   # reset revogou também a sessão girada


def test_reset_antes_do_refresh(sql):
    u = registered(sql)
    s = logged(sql, u, 1)
    issue(sql, u, "r")
    sql.gates.pause_at("reset:locked")
    tr = Runner(sql.resets.complete_reset, h("r"), "x", sql.clock.now())
    tr.start()
    sql.gates.wait_reached("reset:locked")
    tf = Runner(sql.sessions.rotate_refresh, h(1), h(2), sql.clock.now())
    tf.start()
    wait_for_lock_waiter(sql.engine)                                # o PostgreSQL mostra a espera
    sql.gates.release("reset:locked")
    assert tr.join_result() == u.id
    assert tf.join_result()[0] is RotationResult.INVALID
    assert sql.sessions.get(s.id).revoked is True
    assert scalar(sql.engine, select(func.count()).select_from(auth_used_refresh_hashes)) == 0


# ---------------------------------------------------------------- dois refreshes / dois resets
def test_dois_refreshes_do_mesmo_token(sql):
    u = registered(sql)
    s = logged(sql, u, 1)
    sql.gates.pause_at("rotate:locked")
    t1 = Runner(sql.sessions.rotate_refresh, h(1), h(2), sql.clock.now())
    t1.start()
    sql.gates.wait_reached("rotate:locked")
    t2 = Runner(sql.sessions.rotate_refresh, h(1), h(3), sql.clock.now())
    t2.start()
    wait_for_lock_waiter(sql.engine)                                # o PostgreSQL mostra a espera
    sql.gates.release("rotate:locked")
    results = sorted(r.join_result()[0].value for r in (t1, t2))
    assert results == ["reused", "rotated"]
    assert sql.sessions.get(s.id).revoked is True                   # reutilização detectada → família revogada


def test_dois_resets_do_mesmo_token(sql):
    u = registered(sql)
    issue(sql, u, "r")
    sql.gates.pause_at("reset:locked")
    t1 = Runner(sql.resets.complete_reset, h("r"), "senha-1", sql.clock.now())
    t1.start()
    sql.gates.wait_reached("reset:locked")
    t2 = Runner(sql.resets.complete_reset, h("r"), "senha-2", sql.clock.now())
    t2.start()
    wait_for_lock_waiter(sql.engine)                                # o PostgreSQL mostra a espera
    sql.gates.release("reset:locked")
    assert sorted([str(t1.join_result()), str(t2.join_result())]) == sorted([u.id, "None"])
    assert sql.users.get_by_id(u.id).credential_version == 1        # uma única redefinição


def test_pedidos_de_recuperacao_simultaneos_deixam_um_token_ativo(sql):
    u = registered(sql)
    sql.gates.pause_at("forgot:locked")
    t1 = Runner(issue, sql, u, "a")
    t1.start()
    sql.gates.wait_reached("forgot:locked")
    t2 = Runner(issue, sql, u, "b")
    t2.start()
    wait_for_lock_waiter(sql.engine)                                # o PostgreSQL mostra a espera
    sql.gates.release("forgot:locked")
    t1.join_result()
    t2.join_result()
    active = scalar(sql.engine, select(func.count()).select_from(password_reset_tokens).where(
        password_reset_tokens.c.used_at.is_(None), password_reset_tokens.c.invalidated_at.is_(None)))
    assert active == 1
    assert sql.resets.is_active(h("b"), sql.clock.now()) is True


# ---------------------------------------------------------------- limite de sessões e teto
def test_limite_de_sessoes_concorrente(sql):
    u = registered(sql)
    runners = [Runner(sql.sessions.add_if_credentials_current, new_session(u, sql.clock.now(), h(f"c{i}")))
               for i in range(6)]
    for r in runners:
        r.start()
    assert all(r.join_result() is True for r in runners)
    assert scalar(sql.engine, select(func.count()).select_from(auth_sessions)) == 2   # max_sessions_per_user=2


def test_teto_de_rotacoes_revoga_confirma_e_primeiro_token_e_reutilizacao(sql):
    u = registered(sql)
    s = logged(sql, u, 0)
    for i in range(3):
        assert sql.sessions.rotate_refresh(h(i), h(i + 1), sql.clock.now())[0] is RotationResult.ROTATED
    assert sql.sessions.rotate_refresh(h(3), h(9), sql.clock.now())[0] is RotationResult.LIMIT_REACHED
    with sql.engine.connect() as c:                                 # outra conexão vê a revogação confirmada
        revoked_at = c.execute(select(auth_sessions.c.revoked_at).where(auth_sessions.c.id == uuid.UUID(s.id)))
        assert revoked_at.scalar_one() is not None
    assert sql.sessions.rotate_refresh(h(0), h(8), sql.clock.now())[0] is RotationResult.REUSED
    assert scalar(sql.engine, select(func.count()).select_from(auth_used_refresh_hashes)) == 3   # histórico mantido


# ---------------------------------------------------------------- relógio pós-lock
def _lock_session(conn, session_id) -> None:
    conn.execute(select(auth_sessions.c.id).where(auth_sessions.c.id == uuid.UUID(session_id)).with_for_update())


@pytest.mark.parametrize("advance, expected", [(0, RotationResult.ROTATED), (61, RotationResult.INVALID)])
def test_expiracao_durante_a_espera_usa_o_relogio_pos_lock(sql, advance, expected):
    u = registered(sql)
    s = logged(sql, u, 1, ttl=60)
    t = Runner(sql.sessions.rotate_refresh, h(1), h(2), sql.clock.now())   # `now` passado ANTES da espera
    with control_connection(sql.engine) as holder:                  # rollback/close em finally
        _lock_session(holder, s.id)                                 # o teste segura a sessão
        t.start()
        wait_for_lock_waiter(sql.engine, blocked_by=backend_pid(holder))  # a rotação está presa NESSE bloqueio
        sql.clock.advance(advance)                                  # tempo passa enquanto espera
        holder.rollback()                                           # libera
    assert t.join_result()[0] is expected


def test_instante_exato_da_expiracao_apos_espera(sql):
    u = registered(sql)
    s = logged(sql, u, 1, ttl=60)
    t = Runner(sql.sessions.rotate_refresh, h(1), h(2), sql.clock.now())
    with control_connection(sql.engine) as holder:
        _lock_session(holder, s.id)
        t.start()
        wait_for_lock_waiter(sql.engine, blocked_by=backend_pid(holder))
        sql.clock.advance(60)                                       # tx_now == expires_at → expirada
        holder.rollback()
    assert t.join_result()[0] is RotationResult.INVALID


def test_token_de_recuperacao_expira_durante_a_espera(sql):
    u = registered(sql)
    issue(sql, u, "r", ttl=30)
    t = Runner(sql.resets.complete_reset, h("r"), "x", sql.clock.now())
    with control_connection(sql.engine) as holder:
        holder.execute(select(users.c.id).where(users.c.id == uuid.UUID(u.id)).with_for_update())
        t.start()
        wait_for_lock_waiter(sql.engine, blocked_by=backend_pid(holder))
        sql.clock.advance(30)
        holder.rollback()
    assert t.join_result() is None
    assert sql.users.get_by_id(u.id).credential_version == 0        # nada mudou


# ---------------------------------------------------------------- falhas injetadas antes do COMMIT
def test_falha_antes_do_commit_no_login_nao_deixa_sessao(sql):
    u = registered(sql)
    sql.gates.fail_at("login:before_commit")
    with pytest.raises(RuntimeError):
        sql.sessions.add_if_credentials_current(new_session(u, sql.clock.now(), h(1)))
    assert scalar(sql.engine, select(func.count()).select_from(auth_sessions)) == 0


def test_falha_antes_do_commit_na_rotacao_nao_gira(sql):
    u = registered(sql)
    s = logged(sql, u, 1)
    sql.gates.fail_at("rotate:before_commit")
    with pytest.raises(RuntimeError):
        sql.sessions.rotate_refresh(h(1), h(2), sql.clock.now())
    sql.gates.failing.clear()
    assert scalar(sql.engine, select(func.count()).select_from(auth_used_refresh_hashes)) == 0
    assert sql.sessions.get(s.id).rotation_count == 0
    assert sql.sessions.rotate_refresh(h(1), h(3), sql.clock.now())[0] is RotationResult.ROTATED   # token original vale


def test_falha_antes_do_commit_na_redefinicao_nao_muda_nada(sql):
    u = registered(sql)
    s = logged(sql, u, 1)
    issue(sql, u, "r")
    sql.gates.fail_at("reset:before_commit")
    with pytest.raises(RuntimeError):
        sql.resets.complete_reset(h("r"), "senha-nova", sql.clock.now())
    after = sql.users.get_by_id(u.id)
    assert (after.password_hash, after.credential_version) == (u.password_hash, 0)
    assert sql.sessions.get(s.id).revoked is False
    assert sql.resets.is_active(h("r"), sql.clock.now()) is True    # token não foi consumido


def test_conexoes_devolvidas_ao_pool_apos_falhas(sql):
    u = registered(sql)
    sql.gates.fail_at("login:before_commit")
    for i in range(5):
        with pytest.raises(RuntimeError):
            sql.sessions.add_if_credentials_current(new_session(u, sql.clock.now(), h(f"f{i}")))
    assert sql.engine.pool.checkedout() == 0
    with sql.engine.connect() as c:
        assert c.execute(text("SELECT 1")).scalar_one() == 1
    _ = timedelta
