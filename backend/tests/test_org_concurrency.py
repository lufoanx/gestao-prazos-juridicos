"""Etapa 3 — concorrência (threads com Barrier/Event, sem sleeps).

Os serviços e o repositório são os REAIS; as asserções valem para qualquer intercalação.
"""
import threading
from concurrent.futures import ThreadPoolExecutor

from app.domain.org import ADMIN_PERMISSIONS, MEMBER_PERMISSIONS
from tests.org_utils import API, MEMBER

MANAGER = frozenset(MEMBER_PERMISSIONS | {"team.manage"})


def _parallel(*fns):
    barrier = threading.Barrier(len(fns))

    def run(fn):
        barrier.wait()
        try:
            return fn()
        except Exception as exc:  # AppError
            return exc

    with ThreadPoolExecutor(max_workers=len(fns)) as pool:
        return [f.result() for f in [pool.submit(run, fn) for fn in fns]]


def _ok(results):
    return [r for r in results if not isinstance(r, Exception)]


def _codes(results):
    return sorted(getattr(r, "code", "ok") for r in results)


def test_criacao_concorrente_pelo_mesmo_usuario(org):
    o = org()
    ana = o.person("ana")
    svc = o.service
    results = _parallel(*[lambda i=i: svc.create_office(ana.id, f"Esc {i}", "Admin", ()) for i in range(8)])
    assert len(_ok(results)) == 1
    assert _codes(results).count("already_in_office") == 7
    assert len(o.store.offices) == 1 and len(o.store.membership_by_user) == 1


def test_ingresso_concorrente_em_dois_escritorios(org):
    o = org()
    a1, a2, bia = o.person("a1"), o.person("a2"), o.person("bia")
    t1, t2 = o.invite(a1, o.office(a1, "Um")), o.invite(a2, o.office(a2, "Dois"))
    svc = o.service
    results = _parallel(lambda: svc.accept_invitation(bia.id, t1, "1.1.1.1"),
                        lambda: svc.accept_invitation(bia.id, t2, "1.1.1.2"))
    assert len(_ok(results)) == 1 and _codes(results).count("already_in_office") == 1
    used = [i for i in o.store.invitations.values() if i.status == "accepted"]
    assert len(used) == 1 and used[0].office_id == o.membership(bia).office_id


def test_aceitacao_concorrente_do_mesmo_convite(org):
    o = org()
    ana = o.person("ana")
    token = o.invite(ana, o.office(ana))
    people = [o.person(f"p{i}") for i in range(8)]
    svc = o.service
    results = _parallel(*[lambda p=p: svc.accept_invitation(p.id, token, f"10.0.0.{i}")
                          for i, p in enumerate(people)])
    assert len(_ok(results)) == 1
    assert _codes(results).count("invitation_used") == 7
    assert sum(1 for p in people if o.membership(p)) == 1


def test_aceitacao_concorrendo_com_revogacao(org):
    o = org()
    ana = o.person("ana")
    oid = o.office(ana)
    for _ in range(6):
        bia = o.person()
        token = o.invite(ana, oid)
        inv = next(i for i in o.store.invitations.values() if i.status == "pending")
        svc = o.service
        accept, revoke = _parallel(lambda: svc.accept_invitation(bia.id, token, "1.1.1.1"),
                                   lambda: svc.revoke_invitation(ana.id, oid, inv.id))
        final = o.store.invitations[inv.id]
        if isinstance(accept, Exception):         # revogação venceu
            assert accept.code == "invitation_revoked" and final.status == "revoked" and o.membership(bia) is None
            assert not isinstance(revoke, Exception)
        else:                                     # aceitação venceu
            assert revoke.code == "invitation_not_pending" and final.status == "accepted"
            assert o.membership(bia).office_id == oid


def test_aprovacao_concorrendo_com_aceitacao_de_convite(org):
    o = org()
    a1, a2 = o.person("a1"), o.person("a2")
    o1, o2 = o.office(a1, "Um"), o.office(a2, "Dois")
    code = o.http.get(f"{API}/offices/{o1}/join-code", headers=a1.headers).json()["joinCode"]
    for _ in range(6):
        bia = o.person()
        req, _ = o.service.create_join_request(bia.id, code, "9.9.9.9")
        token = o.invite(a2, o2)
        svc = o.service
        approve, accept = _parallel(lambda: svc.approve_request(a1.id, o1, req.id),
                                    lambda: svc.accept_invitation(bia.id, token, "2.2.2.2"))
        m = o.membership(bia)
        final = o.store.requests[req.id]
        assert m is not None and len([1 for x in o.store.membership_by_user if x == bia.id]) == 1
        if m.office_id == o1:
            assert final.status == "approved" and accept.code == "already_in_office"
        else:
            assert final.status == "cancelled" and isinstance(approve, Exception)
            assert approve.code in ("already_in_office", "request_not_pending")


def test_rebaixamento_concorrente_dos_dois_ultimos_administradores(org):
    o = org()
    for _ in range(6):
        a, b = o.person(), o.person()
        oid = o.office(a, "Esc")
        o.join(a, oid, b)
        o.service.promote(a.id, oid, b.id)
        svc = o.service
        results = _parallel(
            lambda: svc.update_member(a.id, oid, b.id, permissions=MANAGER),
            lambda: svc.update_member(b.id, oid, a.id, permissions=MANAGER),
        )
        admins = [m for m in o.store.membership_by_user.values() if m.office_id == oid and m.is_admin]
        assert len(admins) == 1                                 # nunca zero
        assert len(_ok(results)) == 1
        # o perdedor perdeu a autoridade (403) ou bateu no último admin (409)
        assert [getattr(r, "code", None) for r in results if isinstance(r, Exception)][0] in ("forbidden", "last_admin")


def test_auto_rebaixamento_concorrente_dos_ultimos_administradores(org):
    o = org()
    for _ in range(6):
        a, b = o.person(), o.person()
        oid = o.office(a, "Esc")
        o.join(a, oid, b)
        o.service.promote(a.id, oid, b.id)
        svc = o.service
        _parallel(lambda: svc.update_member(a.id, oid, a.id, permissions=MANAGER),
                  lambda: svc.update_member(b.id, oid, b.id, permissions=MANAGER))
        admins = [m for m in o.store.membership_by_user.values() if m.office_id == oid and m.is_admin]
        assert len(admins) == 1


class GateRepo:
    """Envolve o repositório real: pausa a thread `hold` DENTRO da transação."""

    def __init__(self, inner):
        self._inner = inner
        self.hold = None
        self.inside = threading.Event()
        self.release = threading.Event()
        self.about_to_lock = threading.Event()
        self.waiter = None

    def purge(self, now):
        return self._inner.purge(now)

    def transaction(self, now):
        from contextlib import contextmanager

        @contextmanager
        def tx():
            name = threading.current_thread().name
            if name == self.waiter:
                self.about_to_lock.set()
            with self._inner.transaction(now) as t:
                if name == self.hold:
                    self.inside.set()
                    assert self.release.wait(30)
                yield t
        return tx()


def test_alteracao_administrativa_concorrendo_com_perda_de_autoridade(org):
    """gil inicia uma alteração enquanto ana (dentro da transação) retira o team.manage dele.

    A autorização de gil é lida dentro da transação, depois do commit de ana → 403.
    """
    o = org()
    ana, gil, bia = o.person("ana"), o.person("gil"), o.person("bia")
    oid = o.office(ana)
    o.join(ana, oid, gil)
    o.join(ana, oid, bia)
    o.service.update_member(ana.id, oid, gil.id, permissions=MANAGER)
    gate = GateRepo(o.service._repo)
    o.service._repo = gate
    gate.hold, gate.waiter = "ana", "gil"
    out = {}

    def run(name, fn):
        def target():
            try:
                out[name] = fn()
            except Exception as exc:
                out[name] = exc
        t = threading.Thread(target=target, name=name)
        t.start()
        return t

    ta = run("ana", lambda: o.service.update_member(ana.id, oid, gil.id, permissions=frozenset(MEMBER)))
    assert gate.inside.wait(30)
    tg = run("gil", lambda: o.service.update_member(gil.id, oid, bia.id, permissions=frozenset({"deadline.read"})))
    assert gate.about_to_lock.wait(30)
    gate.release.set()
    ta.join(30)
    tg.join(30)
    assert not isinstance(out["ana"], Exception)
    assert getattr(out["gil"], "code", None) == "forbidden"
    assert o.membership(bia).permissions == frozenset(MEMBER_PERMISSIONS)


def test_aprovacoes_concorrentes_da_mesma_solicitacao(org):
    o = org()
    ana, gil, bia = o.person("ana"), o.person("gil"), o.person("bia")
    oid = o.office(ana)
    o.join(ana, oid, gil)
    o.service.update_member(ana.id, oid, gil.id, permissions=MANAGER)
    code = o.service.get_join_code(ana.id, oid)
    req, _ = o.service.create_join_request(bia.id, code, "1.1.1.1")
    svc = o.service
    results = _parallel(lambda: svc.approve_request(ana.id, oid, req.id),
                        lambda: svc.approve_request(gil.id, oid, req.id),
                        lambda: svc.reject_request(gil.id, oid, req.id))
    assert len(_ok(results)) == 1
    assert _codes(results).count("request_not_pending") == 2
    final = o.store.requests[req.id].status
    assert (final == "approved") == (o.membership(bia) is not None)


def test_solicitacoes_concorrentes_duplicadas(org):
    o = org()
    ana, bia = o.person("ana"), o.person("bia")
    oid = o.office(ana)
    code = o.service.get_join_code(ana.id, oid)
    svc = o.service
    results = _parallel(*[lambda i=i: svc.create_join_request(bia.id, code, f"3.3.3.{i}") for i in range(6)])
    assert len(_ok(results)) == 1
    assert sum(1 for r in o.store.requests.values() if r.status == "pending") == 1


def test_admin_unico_promove_e_e_rebaixado_ao_mesmo_tempo(org):
    """Promoção de sucessor concorrendo com auto-rebaixamento: nunca zero administradores."""
    o = org()
    for _ in range(6):
        a, b = o.person(), o.person()
        oid = o.office(a)
        o.join(a, oid, b)
        svc = o.service
        _parallel(lambda: svc.promote(a.id, oid, b.id),
                  lambda: svc.update_member(a.id, oid, a.id, permissions=MANAGER))
        admins = [m for m in o.store.membership_by_user.values() if m.office_id == oid and m.is_admin]
        assert len(admins) >= 1
        assert all(m.permissions <= ADMIN_PERMISSIONS for m in admins)
