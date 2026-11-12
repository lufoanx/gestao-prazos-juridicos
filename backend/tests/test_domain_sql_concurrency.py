"""P4 — concorrência, rollback e consistência do domínio no PostgreSQL real.

Coordenação: pontos de controle (`Gates`) seguram uma operação DEPOIS de seus bloqueios; a outra só
é considerada "esperando" quando o PostgreSQL MOSTRA a espera (`wait_for_lock_waiter`). Sem sleeps
para ordenar; timeouts só protegem contra travamento. Conexões de controle fecham em `finally`.
"""
from __future__ import annotations

import uuid
from datetime import timedelta

import pytest
from sqlalchemy import select, text

from app.db.tables import offices
from tests.auth_sql_support import Gates, Runner, backend_pid, control_connection, wait_for_lock_waiter
from tests.conftest import FakeClock
from tests.deadline_utils import body, create, patch
from tests.intimation_utils import confirm, register
from tests.org_utils import ALL, API, MEMBER, OrgClient, fast_hasher

pytestmark = pytest.mark.postgres


@pytest.fixture
def env(pg_app):
    gates, clock = Gates(), FakeClock()

    def build(**extra):
        app = pg_app(OFFICES_ENABLED="true", password_hasher=fast_hasher(), clock=clock, sql_checkpoint=gates, **extra)
        o = OrgClient(app)
        ana, bia, caio = o.person("ana"), o.person("bia"), o.person("caio")
        oid = o.office(ana)
        o.join(ana, oid, bia)
        o.join(ana, oid, caio)
        return o, oid, ana, bia, caio

    build.gates, build.clock = gates, clock
    return build


def post(o, path, person, json=None):
    return o.http.post(f"{API}{path}", headers=person.headers, json=json or {})


def count(engine, table: str) -> int:
    with engine.connect() as c:
        return c.execute(text(f"SELECT count(*) FROM prazoai.{table}")).scalar_one()


def held(gates, name):
    gates.pause_at(name)
    return name


# ---------------------------------------------------------------- confirmação e ingresso
def test_confirmacoes_simultaneas_da_mesma_intimacao(env, pg_schema):
    o, oid, ana, bia, _ = env()
    i = register(o, ana, suggestedResponsibleId=bia.id)
    gate = held(env.gates, "unit:prepare")
    first = Runner(confirm, o, ana, i["id"], 1, responsibleId=bia.id)
    first.start()
    env.gates.wait_reached(gate)                                     # 1ª já tem os bloqueios
    second = Runner(confirm, o, ana, i["id"], 1, responsibleId=bia.id)
    second.start()
    wait_for_lock_waiter(pg_schema)                                  # 2ª esperando no banco
    env.gates.release(gate)
    r1, r2 = first.join_result(), second.join_result()
    assert sorted([r1.status_code, r2.status_code]) == [200, 201]
    assert {r1.json()["deadline"]["id"], r2.json()["deadline"]["id"]} == {r1.json()["deadline"]["id"]}
    assert count(pg_schema, "deadlines") == 1                        # um único prazo


def test_ingresso_concorrente_em_escritorios_diferentes(env, pg_schema):
    o, oid, ana, bia, caio = env()
    dani, zed = o.person("dani"), o.person("zed")
    zid = o.office(zed, "Outro")
    t1, t2 = o.invite(ana, oid), o.invite(zed, zid)
    gate = held(env.gates, "org:prepare")
    a = Runner(post, o, "/invitations/accept", dani, {"token": t1})
    a.start()
    env.gates.wait_reached(gate)
    b = Runner(post, o, "/invitations/accept", dani, {"token": t2})
    b.start()
    wait_for_lock_waiter(pg_schema)                                  # 2º vínculo espera o 1º (mesma PK)
    env.gates.release(gate)
    ra, rb = a.join_result(), b.join_result()
    assert ra.status_code == 200 and rb.status_code == 409 and rb.json()["error"]["code"] == "already_in_office"
    assert o.membership(dani).office_id == oid


# ---------------------------------------------------------------- remoção × atribuição
@pytest.mark.parametrize("first", ["create", "remove"])
def test_remocao_de_membro_concorrendo_com_atribuicao(env, pg_schema, first):
    o, oid, ana, bia, caio = env()
    ops = {
        "create": lambda: post(o, "/deadlines", ana, body(responsibleId=caio.id)),
        "remove": lambda: post(o, f"/offices/{oid}/members/{caio.id}/remove", ana, {"reassignTo": bia.id}),
    }
    gate = held(env.gates, "unit:prepare")
    a = Runner(ops[first])
    a.start()
    env.gates.wait_reached(gate)
    b = Runner(ops["remove" if first == "create" else "create"])
    b.start()
    wait_for_lock_waiter(pg_schema)
    env.gates.release(gate)
    ra, rb = a.join_result(), b.join_result()
    assert o.membership(caio) is None
    deadlines = o.app.state.org.deadline_store.deadlines
    if first == "create":                                            # prazo criado e depois reatribuído junto
        assert ra.status_code == 201 and rb.status_code == 204
        assert [d.responsible_id for d in deadlines.values()] == [bia.id]
    else:                                                            # criação revalida: caio já saiu
        assert ra.status_code == 204 and rb.status_code in (409, 422)
        assert deadlines == {}


# ---------------------------------------------------------------- perda de autoridade
def test_perda_de_autoridade_concorrendo_com_mutacao_administrativa(env, pg_schema):
    o, oid, ana, bia, caio = env()
    assert o.set_perms(ana, oid, bia, [*MEMBER, "team.manage"]).status_code == 200
    bia = o.relogin(bia)
    gate = held(env.gates, "org:prepare")
    demote = Runner(o.set_perms, ana, oid, bia, MEMBER)
    demote.start()
    env.gates.wait_reached(gate)
    act = Runner(o.http.patch, f"{API}/offices/{oid}/members/{caio.id}", headers=bia.headers,
                 json={"roleLabel": "Estagiário"})
    act.start()
    wait_for_lock_waiter(pg_schema)
    env.gates.release(gate)
    assert demote.join_result().status_code == 200
    assert act.join_result().status_code == 403                      # autoridade revalidada após o bloqueio
    assert o.membership(caio).role_label == "Membro"


def test_perda_de_permissao_concorrendo_com_edicao_sql(env, pg_schema):
    o, oid, ana, bia, _ = env()
    d = create(o, ana, responsibleId=bia.id)
    gate = held(env.gates, "org:prepare")
    demote = Runner(o.set_perms, ana, oid, bia, ["deadline.read"])
    demote.start()
    env.gates.wait_reached(gate)
    edit = Runner(patch, o, bia, d["id"], 1, title="Editado tarde")
    edit.start()
    wait_for_lock_waiter(pg_schema)
    env.gates.release(gate)
    assert demote.join_result().status_code == 200
    assert edit.join_result().status_code == 403
    assert o.app.state.org.deadline_store.deadlines[d["id"]].title == "Contestação"


def test_perda_de_permissao_concorrendo_com_confirmacao_sql(env, pg_schema):
    o, oid, ana, bia, _ = env()
    i = register(o, bia, suggestedResponsibleId=bia.id)
    gate = held(env.gates, "org:prepare")
    demote = Runner(o.set_perms, ana, oid, bia, ["deadline.read"])
    demote.start()
    env.gates.wait_reached(gate)
    conf = Runner(confirm, o, bia, i["id"], 1, responsibleId=bia.id)
    conf.start()
    wait_for_lock_waiter(pg_schema)
    env.gates.release(gate)
    assert demote.join_result().status_code == 200
    assert conf.join_result().status_code == 403                     # permissão revalidada após o bloqueio
    assert count(pg_schema, "deadlines") == 0


# ---------------------------------------------------------------- transferência × edição
def test_transferencia_concorrendo_com_edicao(env, pg_schema):
    o, oid, ana, bia, _ = env()
    d = create(o, ana, scope="personal")
    gate = held(env.gates, "transfer:deadline")
    move = Runner(post, o, f"/deadlines/{d['id']}/transfer", ana,
                  {"version": 1, "officeId": oid, "confirmSharing": True})
    move.start()
    env.gates.wait_reached(gate)
    edit = Runner(patch, o, ana, d["id"], 1, title="Editado")
    edit.start()
    wait_for_lock_waiter(pg_schema)
    env.gates.release(gate)
    assert move.join_result().status_code == 200
    r = edit.join_result()
    assert r.status_code == 409 and r.json()["error"]["code"] == "version_conflict"
    final = o.app.state.org.deadline_store.deadlines[d["id"]]
    assert (final.scope.kind, final.version, final.title) == ("office", 2, "Contestação")


# ---------------------------------------------------------------- capacidade e caixa
def test_escritores_concorrentes_no_limite_de_capacidade(env, pg_schema):
    o, oid, ana, bia, _ = env(DEADLINES_MAX_PER_SCOPE="10")
    for _ in range(9):
        create(o, ana)
    gate = held(env.gates, "unit:prepare")
    a = Runner(post, o, "/deadlines", ana, body())
    a.start()
    env.gates.wait_reached(gate)                                     # 1º passou na verificação (10/10)
    b = Runner(post, o, "/deadlines", bia, body())
    b.start()
    wait_for_lock_waiter(pg_schema)
    env.gates.release(gate)
    ra, rb = a.join_result(), b.join_result()
    assert ra.status_code == 201 and rb.status_code == 409
    assert rb.json()["error"]["code"] == "deadline_limit_reached"
    assert count(pg_schema, "deadlines") == 10


def test_deduplicacao_e_capacidade_da_caixa_com_escritores_concorrentes(env, pg_schema):
    o, oid, ana, bia, caio = env(NOTIFICATIONS_MAX_PER_RECIPIENT="10")
    for _ in range(10):
        create(o, ana, responsibleId=bia.id)
        env.clock.advance(1)                                         # instantes distintos: "mais antiga" é inequívoca
    store = o.app.state.org.unit_of_work.notification_store
    oldest = sorted(store.notifications.values(), key=lambda n: (n.created_at, n.id))
    read_one = oldest[5]
    assert post(o, f"/notifications/{read_one.id}/read", bia).status_code == 200
    gate = held(env.gates, "unit:prepare")
    a = Runner(post, o, "/deadlines", ana, body(responsibleId=bia.id))
    a.start()
    env.gates.wait_reached(gate)
    b = Runner(post, o, "/deadlines", ana, body(responsibleId=bia.id, title="Segundo"))
    b.start()
    wait_for_lock_waiter(pg_schema)
    env.gates.release(gate)
    assert a.join_result().status_code == 201 and b.join_result().status_code == 201
    left = store.notifications
    assert len(left) == 10                                           # limite respeitado
    assert read_one.id not in left                                   # lida sai primeiro…
    assert oldest[0].id not in left                                  # …depois a não lida mais antiga
    # Deduplicação: o mesmo evento não gera segunda notificação.
    uow, clock = o.app.state.org.unit_of_work, o.app.state.auth.clock
    n = next(iter(left.values()))
    from dataclasses import replace

    with uow.unit(clock) as tx:
        assert tx.notifications.add(replace(n, id=uuid.uuid4().hex)) is False


# ---------------------------------------------------------------- código de ingresso
def test_colisao_de_codigo_gera_outro_sem_abortar(env, pg_schema, monkeypatch):
    o, oid, ana, *_ = env()
    existing = o.store.offices[oid].join_code
    from app.services import org_service

    calls = iter([existing, "ZZZZZZZZ23"])
    monkeypatch.setattr(org_service.OrgService, "_new_code", lambda self, tx: next(calls))
    zed = o.person("zed")
    r = post(o, "/offices", zed, {"name": "Novo"})
    assert r.status_code == 201
    with pg_schema.connect() as c:
        codes = sorted(c.execute(select(offices.c.join_code)).scalars())
    assert codes == sorted([existing, "ZZZZZZZZ23"])                 # colisão no SAVEPOINT; seguiu válida


def test_colisao_persistente_falha_sem_criar_nada(env, pg_schema, monkeypatch):
    o, oid, ana, *_ = env()
    existing = o.store.offices[oid].join_code
    from app.services import org_service

    monkeypatch.setattr(org_service.OrgService, "_new_code", lambda self, tx: existing)
    zed = o.person("zed")
    r = post(o, "/offices", zed, {"name": "Novo"})
    assert r.status_code == 503 and r.json()["error"]["code"] == "join_code_unavailable"
    assert count(pg_schema, "offices") == 1 and o.membership(zed) is None


# ---------------------------------------------------------------- relógio pós-lock (convites)
def _invitation(o, oid, ana, ttl_left: float):
    token = o.invite(ana, oid)
    inv = next(i for i in o.store.invitations.values() if i.status == "pending")
    return token, inv


@pytest.mark.parametrize("advance, expected", [(0, 200), (None, 410)])
def test_convite_expira_durante_a_espera_pela_ancora(env, pg_schema, advance, expected):
    o, oid, ana, *_ = env()
    token, inv = _invitation(o, oid, ana, 0)
    dani = o.person("dani")
    t = Runner(post, o, "/invitations/accept", dani, {"token": token})
    with control_connection(pg_schema) as holder:                    # segura a âncora do escritório
        holder.execute(select(offices.c.id).where(offices.c.id == uuid.UUID(oid)).with_for_update())
        t.start()
        wait_for_lock_waiter(pg_schema, blocked_by=backend_pid(holder))
        if advance is None:
            env.clock.advance((inv.expires_at - env.clock.now()).total_seconds() + 1)
        holder.rollback()
    assert t.join_result().status_code == expected


def test_convite_no_instante_exato_apos_espera(env, pg_schema):
    o, oid, ana, *_ = env()
    token, inv = _invitation(o, oid, ana, 0)
    dani = o.person("dani")
    t = Runner(post, o, "/invitations/accept", dani, {"token": token})
    with control_connection(pg_schema) as holder:
        holder.execute(select(offices.c.id).where(offices.c.id == uuid.UUID(oid)).with_for_update())
        t.start()
        wait_for_lock_waiter(pg_schema, blocked_by=backend_pid(holder))
        env.clock.advance((inv.expires_at - env.clock.now()).total_seconds())   # exatamente expires_at
        holder.rollback()
    r = t.join_result()
    assert r.status_code == 410 and r.json()["error"]["code"] == "invitation_expired"


def test_revogacao_usa_o_horario_pos_lock(env, pg_schema):
    o, oid, ana, *_ = env()
    token, inv = _invitation(o, oid, ana, 0)
    t = Runner(post, o, f"/offices/{oid}/invitations/{inv.id}/revoke", ana)
    with control_connection(pg_schema) as holder:
        holder.execute(select(offices.c.id).where(offices.c.id == uuid.UUID(oid)).with_for_update())
        t.start()
        wait_for_lock_waiter(pg_schema, blocked_by=backend_pid(holder))
        env.clock.advance((inv.expires_at - env.clock.now()).total_seconds())
        holder.rollback()
    r = t.join_result()
    assert r.status_code == 409 and r.json()["error"]["code"] == "invitation_not_pending"
    assert o.store.invitations[inv.id].status == "pending"


def test_teto_de_pendentes_usa_o_horario_pos_lock(pg_app, pg_schema):
    clock, gates = FakeClock(), Gates()
    o = OrgClient(pg_app(OFFICES_ENABLED="true", password_hasher=fast_hasher(), clock=clock, sql_checkpoint=gates,
                         ORG_INVITE_TTL_SECONDS="3600", ORG_MAX_PENDING_INVITES_PER_OFFICE="1"))
    ana = o.person("ana")
    oid = o.office(ana)
    o.invite(ana, oid)
    inv = next(iter(o.store.invitations.values()))
    t = Runner(post, o, f"/offices/{oid}/invitations", ana, {"roleLabel": "Membro"})
    with control_connection(pg_schema) as holder:
        holder.execute(select(offices.c.id).where(offices.c.id == uuid.UUID(oid)).with_for_update())
        t.start()
        wait_for_lock_waiter(pg_schema, blocked_by=backend_pid(holder))
        clock.advance((inv.expires_at - clock.now()).total_seconds())  # o pendente expira na espera
        holder.rollback()
    r = t.join_result()
    assert r.status_code == 201
    new = next(i for i in o.store.invitations.values() if i.id != inv.id)
    assert new.created_at == clock.now()                             # carimbo pós-lock


def test_carimbos_da_aprovacao_pos_lock(env, pg_schema):
    o, oid, ana, *_ = env()
    dani = o.person("dani")
    code = o.http.get(f"{API}/offices/{oid}/join-code", headers=ana.headers).json()["joinCode"]
    rid = post(o, "/join-requests", dani, {"joinCode": code}).json()["id"]
    t = Runner(post, o, f"/offices/{oid}/join-requests/{rid}/approve", ana)
    with control_connection(pg_schema) as holder:
        holder.execute(select(offices.c.id).where(offices.c.id == uuid.UUID(oid)).with_for_update())
        t.start()
        wait_for_lock_waiter(pg_schema, blocked_by=backend_pid(holder))
        env.clock.advance(3600)
        holder.rollback()
    assert t.join_result().status_code == 200
    req, m = o.store.requests[rid], o.membership(dani)
    assert req.decided_at == env.clock.now() == m.joined_at


# ---------------------------------------------------------------- rollback entre módulos e no commit
@pytest.mark.parametrize("point", ["reassign:between", "unit:prepare", "unit:commit"])
def test_rollback_integral_em_pontos_entre_modulos(env, pg_schema, point):
    o, oid, ana, bia, caio = env()
    create(o, ana, responsibleId=caio.id)
    register(o, caio)                                                # pendência criada por caio
    from tests.intimation_utils import full_state

    before = full_state(o)[1]
    uow = o.app.state.org.unit_of_work

    def fault(name):
        if name == point:
            raise RuntimeError(f"falha injetada em {name}")

    uow.fault = fault
    try:
        r = post(o, f"/offices/{oid}/members/{caio.id}/remove", ana, {"reassignTo": bia.id})
    finally:
        uow.fault = None
    assert r.status_code == 500
    assert full_state(o)[1] == before                                # nada parcial em nenhum módulo
    assert o.app.state.org.unit_of_work.engine.pool.checkedout() == 0


def test_falha_real_no_commit_por_fk_diferida_desfaz_tudo(env, pg_schema):
    o, oid, ana, bia, caio = env()
    from dataclasses import replace

    from app.domain.errors import ConsistencyError

    d = create(o, ana, responsibleId=bia.id)
    zed = o.person("zed")
    uow, clock = o.app.state.org.unit_of_work, o.app.state.auth.clock
    with pytest.raises(ConsistencyError, match="fk_deadlines_active_responsible"):
        with uow.unit(clock) as tx:                                  # escrita direta inválida (sem serviço)
            cur = tx.deadlines.get(d["id"])
            tx.deadlines.put(replace(cur, responsible_id=zed.id, title="Parcial"))
    assert o.app.state.org.deadline_store.deadlines[d["id"]].title == "Contestação"


# ---------------------------------------------------------------- consistência das leituras
def test_listagem_coerente_quando_outra_conexao_cria_entre_consultas(env, pg_schema):
    o, oid, ana, bia, _ = env()
    for _ in range(3):
        create(o, ana)
    gate = held(env.gates, "query:after_count")
    reader = Runner(o.http.get, f"{API}/deadlines", headers=ana.headers, params={"scope": "office", "perPage": 50})
    reader.start()
    env.gates.wait_reached(gate)                                     # total já calculado no snapshot
    env.gates.reached.pop(gate)
    assert post(o, "/deadlines", ana, body(title="Criado no meio")).status_code == 201
    env.gates.released[gate].set()
    r = reader.join_result().json()
    assert r["total"] == 3 and len(r["items"]) == 3                  # itens e total do MESMO snapshot


def test_notificacoes_coerentes_com_perda_de_permissao_entre_consultas(env, pg_schema):
    o, oid, ana, bia, _ = env()
    for _ in range(2):
        create(o, ana, responsibleId=bia.id)
    o.set_perms(ana, oid, bia, ALL[:4], visibility="assigned")
    gate = held(env.gates, "query:after_count")
    reader = Runner(o.http.get, f"{API}/notifications", headers=bia.headers, params={"scope": "office"})
    reader.start()
    env.gates.wait_reached(gate)
    env.gates.reached.pop(gate)
    assert o.set_perms(ana, oid, bia, ["deadline.create"]).status_code == 200   # perde deadline.read
    env.gates.released[gate].set()
    r = reader.join_result().json()
    assert r["total"] == len(r["items"]) == 2 and r["unread"] == 2           # snapshot anterior, coerente
    after = o.http.get(f"{API}/notifications", headers=bia.headers, params={"scope": "office"}).json()
    assert after["total"] == 0 and after["items"] == [] and after["unread"] == 0


def test_calendario_coerente_com_reatribuicao_entre_consultas(env, pg_schema):
    o, oid, ana, bia, caio = env()
    o.set_perms(ana, oid, bia, MEMBER, visibility="assigned")
    bia = o.relogin(bia)
    d = create(o, ana, responsibleId=bia.id, dueDate="2026-11-20")
    gate = held(env.gates, "query:after_count")
    reader = Runner(o.http.get, f"{API}/calendar", headers=bia.headers,
                    params={"scope": "office", "year": 2026, "month": 11})
    reader.start()
    env.gates.wait_reached(gate)
    env.gates.reached.pop(gate)
    assert patch(o, ana, d["id"], 1, responsibleId=caio.id).status_code == 200   # reatribuído no meio
    env.gates.released[gate].set()
    r = reader.join_result().json()
    assert r["total"] == len(r["items"]) == 1 and sum(r["countsByDay"].values()) == 1


# ---------------------------------------------------------------- páginas vazias e persistência
def test_pagina_alem_da_ultima_com_total_e_contadores(env, pg_schema):
    o, oid, ana, bia, _ = env()
    for _ in range(3):
        create(o, ana, responsibleId=bia.id)
    i = register(o, ana)
    lst = o.http.get(f"{API}/deadlines", headers=ana.headers, params={"scope": "office", "page": 9}).json()
    assert lst["items"] == [] and lst["total"] == 3
    cal = o.http.get(f"{API}/calendar", headers=ana.headers,
                     params={"scope": "office", "year": 2026, "month": 11, "page": 9}).json()
    assert cal["items"] == [] and cal["total"] == 3 and sum(cal["countsByDay"].values()) == 3
    its = o.http.get(f"{API}/intimations", headers=ana.headers, params={"scope": "office", "page": 9}).json()
    assert its["items"] == [] and its["total"] == 1 and i["id"]
    nts = o.http.get(f"{API}/notifications", headers=bia.headers, params={"scope": "office", "page": 9}).json()
    assert nts["items"] == [] and nts["total"] == 3 and nts["unread"] == 3


def test_persistencia_apos_recriar_aplicacao_e_engine(pg_app, pg_schema):
    clock = FakeClock()
    o1 = OrgClient(pg_app(OFFICES_ENABLED="true", password_hasher=fast_hasher(), clock=clock))
    ana, bia = o1.person("ana"), o1.person("bia")
    oid = o1.office(ana)
    o1.join(ana, oid, bia)
    d = create(o1, ana, responsibleId=bia.id)
    i = register(o1, ana, suggestedResponsibleId=bia.id)
    engine1 = o1.app.state.org.unit_of_work.engine
    o1.app.state.auth.close()
    o2 = OrgClient(pg_app(OFFICES_ENABLED="true", password_hasher=fast_hasher(), clock=clock))
    assert o2.app.state.org.unit_of_work.engine is not engine1
    ana, bia = o2.relogin(ana), o2.relogin(bia)
    assert o2.http.get(f"{API}/deadlines/{d['id']}", headers=bia.headers).status_code == 200
    assert o2.http.get(f"{API}/intimations/{i['id']}", headers=bia.headers).status_code == 200
    members = o2.http.get(f"{API}/offices/{oid}/members", headers=ana.headers).json()["members"]
    assert {m["userId"] for m in members} == {ana.id, bia.id}
    nts = o2.http.get(f"{API}/notifications", headers=bia.headers, params={"scope": "office"}).json()
    assert nts["total"] == 2
    _ = timedelta


# ---------------------------------------------------------------- auditoria: relógio realmente pós-lock
def _hold_user(holder, user_id: str) -> None:
    from app.db.tables import users

    holder.execute(select(users.c.id).where(users.c.id == uuid.UUID(user_id)).with_for_update())


def _wait_hold_advance(env, pg_schema, holder, runner, seconds: int):
    runner.start()
    wait_for_lock_waiter(pg_schema, blocked_by=backend_pid(holder))  # espera VISTA no banco
    env.clock.advance(seconds)                                       # só então o tempo passa…
    holder.rollback()                                                # …e a âncora é liberada


def test_prazo_pessoal_usa_o_instante_apos_a_ancora_pessoal(env, pg_schema):
    o, oid, ana, *_ = env()
    before = env.clock.now()
    t = Runner(post, o, "/deadlines", ana, body(scope="personal"))
    with control_connection(pg_schema) as holder:
        _hold_user(holder, ana.id)
        _wait_hold_advance(env, pg_schema, holder, t, 300)
    r = t.join_result()
    assert r.status_code == 201
    after = before + timedelta(seconds=300)
    d = o.app.state.org.deadline_store.deadlines[r.json()["id"]]
    events = o.app.state.org.deadline_store.history[d.id]
    assert d.created_at == d.updated_at == after                     # não o instante pré-espera
    assert [e.at for e in events] == [after]


def test_intimacao_pessoal_usa_o_instante_apos_a_ancora_pessoal(env, pg_schema):
    o, oid, ana, *_ = env()
    before = env.clock.now()
    from tests.intimation_utils import reg_body

    t = Runner(post, o, "/intimations", ana, reg_body(scope="personal"))
    with control_connection(pg_schema) as holder:
        _hold_user(holder, ana.id)
        _wait_hold_advance(env, pg_schema, holder, t, 300)
    r = t.join_result()
    assert r.status_code == 201, r.text
    after = before + timedelta(seconds=300)
    i = o.app.state.org.unit_of_work.intimation_store.intimations[r.json()["id"]]
    events = o.app.state.org.unit_of_work.intimation_store.events[i.id]
    assert i.created_at == i.updated_at == after and all(e.at == after for e in events)


def test_criacao_de_escritorio_usa_o_instante_apos_a_ancora_pessoal(env, pg_schema):
    o, *_ = env()
    zed = o.person("zed")
    before = env.clock.now()
    t = Runner(post, o, "/offices", zed, {"name": "Escritório Z"})
    with control_connection(pg_schema) as holder:
        _hold_user(holder, zed.id)
        _wait_hold_advance(env, pg_schema, holder, t, 300)
    r = t.join_result()
    assert r.status_code == 201
    after = before + timedelta(seconds=300)
    office = o.store.offices[r.json()["office"]["id"]]
    assert office.created_at == after and o.membership(zed).joined_at == after


@pytest.mark.parametrize("first", ["accept", "request"])
def test_solicitacao_concorrendo_com_ingresso_em_outro_escritorio(env, pg_schema, first):
    """Após o ingresso em B, nenhuma solicitação PENDENTE da pessoa pode sobrar em A."""
    o, oid, ana, *_ = env()
    zed, dani = o.person("zed"), o.person("dani")
    zid = o.office(zed, "Escritório B")
    token = o.invite(zed, zid)
    code = o.http.get(f"{API}/offices/{oid}/join-code", headers=ana.headers).json()["joinCode"]
    ops = {"accept": lambda: post(o, "/invitations/accept", dani, {"token": token}),
           "request": lambda: post(o, "/join-requests", dani, {"joinCode": code})}
    gate = held(env.gates, "org:prepare")
    a = Runner(ops[first])
    a.start()
    env.gates.wait_reached(gate)                                     # 1ª segura escritório + pessoa
    b = Runner(ops["request" if first == "accept" else "accept"])
    b.start()
    wait_for_lock_waiter(pg_schema)                                  # 2ª espera a âncora da pessoa
    env.gates.release(gate)
    ra, rb = a.join_result(), b.join_result()
    assert o.membership(dani).office_id == zid
    pending = [r for r in o.store.requests.values() if r.user_id == dani.id and r.status == "pending"]
    assert pending == []                                             # nenhuma escapou do cancelamento
    if first == "accept":
        assert ra.status_code == 200 and rb.status_code == 409
        assert rb.json()["error"]["code"] == "already_in_office"
    else:
        assert ra.status_code == 201 and rb.status_code == 200
        assert [r.status for r in o.store.requests.values() if r.user_id == dani.id] == ["cancelled"]


@pytest.mark.parametrize("operation", ["invite", "approve"])
def test_perda_de_permissao_concorrendo_com_emissao_ou_aprovacao_sql(env, pg_schema, operation):
    o, oid, ana, bia, caio = env()
    gil = o.person("gil")
    o.join(ana, oid, gil)
    manager = [*MEMBER, "team.manage"]                               # MEMBER já inclui deadline.create
    assert o.set_perms(ana, oid, gil, manager).status_code == 200
    gil = o.relogin(gil)
    dani = o.person("dani")
    code = o.http.get(f"{API}/offices/{oid}/join-code", headers=ana.headers).json()["joinCode"]
    rid = post(o, "/join-requests", dani, {"joinCode": code}).json()["id"]
    before = (len(o.store.invitations), o.store.requests[rid].status)
    gate = held(env.gates, "org:prepare")
    reduce = Runner(o.set_perms, ana, oid, gil, [p for p in manager if p != "deadline.create"])
    reduce.start()
    env.gates.wait_reached(gate)
    act = Runner(post, o, f"/offices/{oid}/invitations", gil, {"roleLabel": "Membro"}) if operation == "invite" \
        else Runner(post, o, f"/offices/{oid}/join-requests/{rid}/approve", gil)
    act.start()
    wait_for_lock_waiter(pg_schema)
    env.gates.release(gate)
    assert reduce.join_result().status_code == 200
    r = act.join_result()
    assert r.status_code == 403 and r.json()["error"]["code"] == "delegation_not_allowed"
    assert (len(o.store.invitations), o.store.requests[rid].status) == before and o.membership(dani) is None
