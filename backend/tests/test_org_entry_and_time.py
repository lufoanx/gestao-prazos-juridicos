"""Auditoria da Etapa 3 — delegação aplicada ao ingresso e horário lido após o lock.

Concorrência coordenada com Event/Barrier e relógio injetável (sem sleeps).
"""
import threading
from contextlib import contextmanager

import pytest

from app.domain.org import MEMBER_PERMISSIONS
from tests.org_utils import API, MEMBER

INSUFFICIENT = [["deadline.read", "team.manage"],
                ["deadline.read", "deadline.create", "deadline.complete", "team.manage"]]
MANAGER = MEMBER + ["team.manage"]


def _state(o):
    return (dict(o.store.membership_by_user), dict(o.store.invitations), dict(o.store.requests))


# ======================================================================
# 1. Delegação no ingresso
# ======================================================================
@pytest.fixture
def office(org):
    o = org()
    ana, gil = o.person("ana"), o.person("gil")
    oid = o.office(ana)
    o.join(ana, oid, gil)
    return o, oid, ana, gil


@pytest.mark.parametrize("perms", INSUFFICIENT)
def test_gestor_sem_o_conjunto_de_ingresso_nao_convida(office, perms):
    o, oid, ana, gil = office
    assert o.set_perms(ana, oid, gil, perms).status_code == 200
    before = _state(o)
    r = o.http.post(f"{API}/offices/{oid}/invitations", headers=gil.headers, json={"roleLabel": "X"})
    assert r.status_code == 403 and r.json()["error"]["code"] == "delegation_not_allowed"
    assert _state(o) == before


@pytest.mark.parametrize("perms", INSUFFICIENT)
def test_gestor_sem_o_conjunto_de_ingresso_nao_aprova(office, perms):
    o, oid, ana, gil = office
    bia = o.person("bia")
    code = o.service.get_join_code(ana.id, oid)
    rid = o.http.post(f"{API}/join-requests", headers=bia.headers, json={"joinCode": code}).json()["id"]
    assert o.set_perms(ana, oid, gil, perms).status_code == 200
    before = _state(o)
    r = o.http.post(f"{API}/offices/{oid}/join-requests/{rid}/approve", headers=gil.headers)
    assert r.status_code == 403 and r.json()["error"]["code"] == "delegation_not_allowed"
    assert _state(o) == before                       # solicitação segue pendente, sem vínculo
    assert o.store.requests[rid].status == "pending" and o.membership(bia) is None
    # Rejeitar não concede nada: continua exigindo apenas team.manage.
    assert o.http.post(f"{API}/offices/{oid}/join-requests/{rid}/reject", headers=gil.headers).status_code == 200


def test_gestor_autorizado_convida_e_aprova_com_o_conjunto_completo(office):
    o, oid, ana, gil = office
    assert o.set_perms(ana, oid, gil, MANAGER).status_code == 200
    bia, caio = o.person("bia"), o.person("caio")
    token = o.invite(gil, oid)
    r = o.http.post(f"{API}/invitations/accept", headers=bia.headers, json={"token": token})
    assert r.status_code == 200
    assert r.json()["membership"]["permissions"] == MEMBER and r.json()["membership"]["visibility"] == "assigned"
    code = o.service.get_join_code(gil.id, oid)
    rid = o.http.post(f"{API}/join-requests", headers=caio.headers, json={"joinCode": code}).json()["id"]
    assert o.http.post(f"{API}/offices/{oid}/join-requests/{rid}/approve", headers=gil.headers).status_code == 200
    assert o.membership(caio).permissions == MEMBER_PERMISSIONS     # nunca reduzido em silêncio


def test_convite_valido_continua_utilizavel_apos_reducao_do_emissor(office):
    o, oid, ana, gil = office
    assert o.set_perms(ana, oid, gil, MANAGER).status_code == 200
    token = o.invite(gil, oid)
    assert o.set_perms(ana, oid, gil, ["deadline.read"]).status_code == 200   # emissor perde poderes
    bia = o.person("bia")
    r = o.http.post(f"{API}/invitations/accept", headers=bia.headers, json={"token": token})
    assert r.status_code == 200 and r.json()["membership"]["permissions"] == MEMBER


class HoldInsideTx:
    """Repositório real envolvido: a thread `holder` pausa DENTRO da transação."""

    def __init__(self, inner, holder, waiter):
        self._inner, self.holder, self.waiter = inner, holder, waiter
        self.inside, self.release, self.about_to_lock = threading.Event(), threading.Event(), threading.Event()

    def purge(self, now):
        return self._inner.purge(now)

    def transaction(self, clock):
        @contextmanager
        def tx():
            name = threading.current_thread().name
            if name == self.waiter:
                self.about_to_lock.set()
            with self._inner.transaction(clock) as t:
                if name == self.holder:
                    self.inside.set()
                    assert self.release.wait(30)
                yield t
        return tx()


def _run(name, fn, out):
    def target():
        try:
            out[name] = fn()
        except Exception as exc:
            out[name] = exc
    t = threading.Thread(target=target, name=name)
    t.start()
    return t


@pytest.mark.memory_only(
    "ordena as threads por um gate que só funciona com o lock global da memória; equivalente SQL: "
    "test_domain_sql_concurrency::test_perda_de_permissao_concorrendo_com_emissao_ou_aprovacao_sql"
)
@pytest.mark.parametrize("operation", ["invite", "approve"])
def test_perda_de_permissao_concorrendo_com_emissao_ou_aprovacao(office, operation):
    """ana retira deadline.create de gil DENTRO da transação; a operação de gil, iniciada
    durante a espera, lê a autoridade depois do commit → 403 e nenhum efeito."""
    o, oid, ana, gil = office
    o.service.update_member(ana.id, oid, gil.id, permissions=frozenset(MANAGER))
    bia = o.person("bia")
    code = o.service.get_join_code(ana.id, oid)
    req, _ = o.service.create_join_request(bia.id, code, "1.1.1.1")
    gate = HoldInsideTx(o.service._repo, holder="ana", waiter="gil")
    o.service._repo = gate
    out = {}
    reduced = frozenset(MANAGER) - {"deadline.create"}
    ta = _run("ana", lambda: o.service.update_member(ana.id, oid, gil.id, permissions=reduced), out)
    assert gate.inside.wait(30)
    if operation == "invite":
        fn = lambda: o.service.create_invitation(gil.id, oid, "Membro")  # noqa: E731
    else:
        fn = lambda: o.service.approve_request(gil.id, oid, req.id)  # noqa: E731
    before = (len(o.store.invitations), o.store.requests[req.id].status)
    tg = _run("gil", fn, out)
    assert gate.about_to_lock.wait(30)
    gate.release.set()
    ta.join(30)
    tg.join(30)
    assert not isinstance(out["ana"], Exception)
    assert getattr(out["gil"], "code", None) == "delegation_not_allowed"
    assert (len(o.store.invitations), o.store.requests[req.id].status) == before
    assert o.membership(bia) is None


def test_emissao_concorrente_com_reducao_sem_coordenacao(office):
    """Barreira: qualquer ordem é válida, mas nunca há convite emitido sem autoridade vigente."""
    o, oid, ana, gil = office
    for _ in range(10):
        o.service.update_member(ana.id, oid, gil.id, permissions=frozenset(MANAGER))
        barrier = threading.Barrier(2)
        out = {}

        def invite():
            barrier.wait()
            return o.service.create_invitation(gil.id, oid, "Membro")

        def reduce():
            barrier.wait()
            return o.service.update_member(ana.id, oid, gil.id, permissions=frozenset({"deadline.read", "team.manage"}))

        t1, t2 = _run("i", invite, out), _run("r", reduce, out)
        t1.join(30)
        t2.join(30)
        assert not isinstance(out["r"], Exception)
        if isinstance(out["i"], Exception):
            assert out["i"].code == "delegation_not_allowed"
        else:   # emitido enquanto gil ainda tinha autoridade: convite válido (decisão aprovada)
            inv, _token = out["i"]
            assert o.store.invitations[inv.id].status == "pending"
        assert "deadline.create" not in o.membership(gil).permissions


# ======================================================================
# 2. Horário lido após adquirir o lock
# ======================================================================
@pytest.fixture
def expiring(org, clock):
    o = org(ORG_INVITE_TTL_SECONDS=3600)
    ana, bia = o.person("ana"), o.person("bia")
    oid = o.office(ana)
    token = o.invite(ana, oid)
    inv = next(i for i in o.store.invitations.values())
    return o, oid, ana, bia, token, inv


def _waiting_on_lock(o, name):
    """Envolve o repositório: sinaliza quando a thread `name` chega à aquisição da transação."""
    reached = threading.Event()
    inner = o.service._repo

    class Probe:
        def purge(self, now):
            return inner.purge(now)

        def transaction(self, clock):
            if threading.current_thread().name == name:
                reached.set()
            return inner.transaction(clock)

    o.service._repo = Probe()
    return reached


@pytest.mark.memory_only(
    "segura o RLock da memória; equivalente SQL: "
    "test_domain_sql_concurrency::test_convite_expira_durante_a_espera_pela_ancora"
)
def test_convite_expira_durante_a_espera_pelo_lock(expiring, clock):
    o, oid, ana, bia, token, inv = expiring
    reached = _waiting_on_lock(o, "accept")
    out = {}
    with o.store.lock:                                   # segura o lock do escritório
        t = _run("accept", lambda: o.service.accept_invitation(bia.id, token, "1.1.1.1"), out)
        assert reached.wait(30)                          # chegou à aquisição da transação
        clock.advance((inv.expires_at - clock.now()).total_seconds() + 1)
    t.join(30)
    assert getattr(out["accept"], "code", None) == "invitation_expired"
    assert o.store.invitations[inv.id].status == "pending"   # não consumido
    assert o.membership(bia) is None                          # nenhum vínculo


@pytest.mark.memory_only(
    "segura o RLock da memória; equivalente SQL: "
    "test_domain_sql_concurrency::test_convite_no_instante_exato_apos_espera"
)
def test_expiracao_no_instante_exato(expiring, clock):
    o, oid, ana, bia, token, inv = expiring
    clock.advance((inv.expires_at - clock.now()).total_seconds() - 1)
    assert o.service.lookup_invitation(token, "1.1.1.1") == ("valid", "Escritório Teste")
    reached = _waiting_on_lock(o, "accept")
    out = {}
    with o.store.lock:
        t = _run("accept", lambda: o.service.accept_invitation(bia.id, token, "1.1.1.1"), out)
        assert reached.wait(30)
        clock.advance(1)                                 # agora == expires_at → expirado
    t.join(30)
    assert getattr(out["accept"], "code", None) == "invitation_expired"
    assert o.membership(bia) is None and o.store.invitations[inv.id].status == "pending"


@pytest.mark.memory_only(
    "segura o RLock da memória; equivalente SQL: "
    "test_domain_sql_concurrency::test_revogacao_usa_o_horario_pos_lock"
)
def test_consulta_e_revogacao_usam_o_horario_apos_o_lock(expiring, clock):
    o, oid, ana, bia, token, inv = expiring
    for name, fn, check in [
        ("lookup", lambda: o.service.lookup_invitation(token, "2.2.2.2"),
         lambda r: r == ("expired", None)),
        ("revoke", lambda: o.service.revoke_invitation(ana.id, oid, inv.id),
         lambda r: getattr(r, "code", None) == "invitation_not_pending"),
    ]:
        reached = _waiting_on_lock(o, name)
        out = {}
        with o.store.lock:
            t = _run(name, fn, out)
            assert reached.wait(30)
            if clock.now() < inv.expires_at:
                clock.advance((inv.expires_at - clock.now()).total_seconds())
        t.join(30)
        assert check(out[name]), (name, out[name])
    assert o.store.invitations[inv.id].status == "pending"


@pytest.mark.memory_only(
    "segura o RLock da memória; equivalente SQL: "
    "test_domain_sql_concurrency::test_teto_de_pendentes_usa_o_horario_pos_lock"
)
def test_teto_de_pendentes_conta_com_o_horario_apos_o_lock(org, clock):
    """Convite que expira durante a espera não conta mais no teto de pendentes."""
    o = org(ORG_INVITE_TTL_SECONDS=3600, ORG_MAX_PENDING_INVITES_PER_OFFICE=1)
    ana = o.person("ana")
    oid = o.office(ana)
    o.invite(ana, oid)
    inv = next(iter(o.store.invitations.values()))
    reached = _waiting_on_lock(o, "emit")
    out = {}
    with o.store.lock:
        t = _run("emit", lambda: o.service.create_invitation(ana.id, oid, "Membro"), out)
        assert reached.wait(30)
        clock.advance((inv.expires_at - clock.now()).total_seconds())
    t.join(30)
    assert not isinstance(out["emit"], Exception)
    new_inv, _ = out["emit"]
    assert new_inv.created_at == clock.now()            # carimbo também é o instante pós-lock


@pytest.mark.memory_only(
    "segura o RLock da memória; equivalente SQL: "
    "test_domain_sql_concurrency::test_carimbos_da_aprovacao_pos_lock"
)
def test_carimbos_da_aprovacao_usam_o_horario_apos_o_lock(org, clock):
    o = org()
    ana, bia = o.person("ana"), o.person("bia")
    oid = o.office(ana)
    req, _ = o.service.create_join_request(bia.id, o.service.get_join_code(ana.id, oid), "1.1.1.1")
    reached = _waiting_on_lock(o, "approve")
    out = {}
    with o.store.lock:
        t = _run("approve", lambda: o.service.approve_request(ana.id, oid, req.id), out)
        assert reached.wait(30)
        clock.advance(120)
    t.join(30)
    decided, membership = out["approve"]
    assert decided.decided_at == clock.now() and membership.joined_at == clock.now()


@pytest.mark.memory_only(
    "limpeza oportunista dentro da transação existe só na memória; no PostgreSQL a retenção global é da "
    "P5"
)
def test_limpeza_usa_o_horario_apos_o_lock(org, clock):
    o = org(ORG_CLOSED_RETENTION_SECONDS=24 * 3600)
    ana = o.person("ana")
    oid = o.office(ana)
    token = o.invite(ana, oid)
    inv = next(iter(o.store.invitations.values()))
    o.service.revoke_invitation(ana.id, oid, inv.id)
    o.store.last_purge = None                           # força a varredura na próxima transação
    reached = _waiting_on_lock(o, "lookup")
    out = {}
    with o.store.lock:
        t = _run("lookup", lambda: o.service.lookup_invitation(token, "3.3.3.3"), out)
        assert reached.wait(30)
        clock.advance(24 * 3600)                        # retenção termina durante a espera
    t.join(30)
    assert out["lookup"] == ("invalid", None)           # já removido pela limpeza da transação
    assert inv.id not in o.store.invitations
