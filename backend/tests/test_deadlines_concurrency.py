"""Etapa 4 — concorrência determinística entre prazos e escritórios (Event/Barrier, sem sleeps).

`UnitGate` pausa a thread `holder` DENTRO da unidade de trabalho (locks adquiridos) e
sinaliza quando a thread `waiter` chega à aquisição; assim a ordem é forçada.
"""
import threading
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager

import pytest

from tests.deadline_utils import TRANSFER, create, get


class UnitGate:
    def __init__(self, o, holder, waiter):
        self.uow = o.app.state.org.unit_of_work
        self.inner = self.uow.unit
        self.holder, self.waiter = holder, waiter
        self.inside, self.release, self.about_to_lock = threading.Event(), threading.Event(), threading.Event()
        self.uow.unit = self.unit

    @contextmanager
    def unit(self, clock):
        name = threading.current_thread().name
        if name == self.waiter:
            self.about_to_lock.set()
        with self.inner(clock) as tx:
            if name == self.holder:
                self.inside.set()
                assert self.release.wait(30)
            yield tx

    def close(self):
        self.uow.unit = self.inner


def _run(name, fn, out):
    def target():
        try:
            out[name] = fn()
        except Exception as exc:
            out[name] = exc
    t = threading.Thread(target=target, name=name)
    t.start()
    return t


def ordered(o, first, second):
    """Executa `first` (segura a unidade) e `second` (espera o lock) nessa ordem forçada."""
    gate = UnitGate(o, holder="first", waiter="second")
    out = {}
    t1 = _run("first", first, out)
    assert gate.inside.wait(30)
    t2 = _run("second", second, out)
    assert gate.about_to_lock.wait(30)
    gate.release.set()
    t1.join(30)
    t2.join(30)
    gate.close()
    return out["first"], out["second"]


def invariant(o):
    """Nenhum prazo em aberto do escritório com responsável fora dele."""
    members = o.store.membership_by_user
    for d in o.app.state.org.deadline_store.deadlines.values():
        if d.status == "open" and d.scope.kind == "office":
            m = members.get(d.responsible_id)
            assert m is not None and m.office_id == d.scope.office_id, d


def code(result):
    return getattr(result, "code", "ok")


@pytest.fixture
def env(org):
    o = org()
    ana, bia, caio = o.person("ana"), o.person("bia"), o.person("caio")
    oid = o.office(ana)
    o.join(ana, oid, bia)
    o.join(ana, oid, caio)
    return o, oid, ana, bia, caio


def _data(responsible):
    from tests.deadline_utils import body
    b = body(responsibleId=responsible)
    from app.schemas.deadlines import CreateDeadlineRequest
    req = CreateDeadlineRequest.model_validate(b)
    return req.scope, req.model_dump(exclude={"scope"})


@pytest.mark.parametrize("leave_first", [True, False])
def test_criacao_para_responsavel_concorrendo_com_sua_saida(env, leave_first):
    o, oid, ana, bia, caio = env
    dsvc, osvc = o.app.state.deadlines, o.service
    kind, data = _data(bia.id)
    leave = lambda: osvc.leave(bia.id, oid, None, caio.id)  # noqa: E731
    make = lambda: dsvc.create(ana.id, kind, data)  # noqa: E731
    if leave_first:
        r_leave, r_make = ordered(o, leave, make)
        assert code(r_leave) == "ok" and code(r_make) == "responsible_invalid"
    else:
        r_make, r_leave = ordered(o, make, leave)
        assert code(r_make) == "ok" and code(r_leave) == "ok"
        assert o.app.state.org.deadline_store.deadlines[r_make.id].responsible_id == caio.id   # reatribuído
    invariant(o)


@pytest.mark.parametrize("remove_first", [True, False])
def test_transferencia_concorrendo_com_remocao(env, remove_first):
    o, oid, ana, bia, caio = env
    o.set_perms(ana, oid, bia, TRANSFER)
    p = create(o, bia, scope="personal")
    dsvc, osvc = o.app.state.deadlines, o.service
    transfer = lambda: dsvc.transfer(bia.id, p["id"], 1, oid)  # noqa: E731
    remove = lambda: osvc.remove_member(ana.id, oid, bia.id, caio.id)  # noqa: E731
    if remove_first:
        r_remove, r_transfer = ordered(o, remove, transfer)
        assert code(r_remove) == "ok" and code(r_transfer) == "not_found"
        assert o.app.state.org.deadline_store.deadlines[p["id"]].scope.kind == "personal"
    else:
        r_transfer, r_remove = ordered(o, transfer, remove)
        assert code(r_transfer) == "ok" and code(r_remove) == "ok"
        d = o.app.state.org.deadline_store.deadlines[p["id"]]
        assert d.scope.kind == "office" and d.responsible_id == caio.id
    invariant(o)


@pytest.mark.parametrize("status_first", [True, False])
def test_mudanca_de_status_concorrendo_com_reatribuicao(env, status_first):
    o, oid, ana, bia, caio = env
    d = create(o, ana, responsibleId=bia.id)
    dsvc, osvc = o.app.state.deadlines, o.service
    complete = lambda: dsvc.change_status(ana.id, d["id"], 1, "completed", None)  # noqa: E731
    remove = lambda: osvc.remove_member(ana.id, oid, bia.id, caio.id)  # noqa: E731
    if status_first:
        r_status, r_remove = ordered(o, complete, remove)
        assert code(r_status) == "ok" and code(r_remove) == "ok"
        final = o.app.state.org.deadline_store.deadlines[d["id"]]
        assert final.status == "completed" and final.responsible_id == bia.id   # concluído não é reatribuído
    else:
        r_remove, r_status = ordered(o, remove, complete)
        assert code(r_remove) == "ok" and code(r_status) == "version_conflict"  # reatribuição incrementou a versão
    invariant(o)


def test_perda_de_permissao_concorrendo_com_edicao(env):
    o, oid, ana, bia, caio = env
    d = create(o, ana, responsibleId=bia.id)
    demote = lambda: o.service.update_member(ana.id, oid, bia.id, permissions=frozenset({"deadline.read"}))  # noqa: E731
    edit = lambda: o.app.state.deadlines.update(bia.id, d["id"], 1, {"title": "Editado tarde"})  # noqa: E731
    r_demote, r_edit = ordered(o, lambda: _org_in_unit(o, demote), edit)
    assert code(r_demote) == "ok" and code(r_edit) == "forbidden"
    assert get(o, ana, d["id"]).json()["title"] == "Contestação"


def _org_in_unit(o, fn):
    """Segura a unidade (escritórios → prazos) e, DENTRO dela, executa uma operação de escritório
    (RLock reentrante). O commit da operação acontece antes de a outra thread obter os locks."""
    with o.app.state.org.unit_of_work.unit(o.app.state.auth.clock):
        return fn()


def test_duas_edicoes_com_a_mesma_versao(env):
    o, oid, ana, bia, caio = env
    d = create(o, ana)
    svc = o.app.state.deadlines
    for round_ in range(5):
        v = o.app.state.org.deadline_store.deadlines[d["id"]].version
        barrier = threading.Barrier(2)

        def edit(title, v=v):
            barrier.wait()
            try:
                return svc.update(ana.id, d["id"], v, {"title": title})
            except Exception as exc:
                return exc

        with ThreadPoolExecutor(2) as pool:
            results = list(pool.map(edit, [f"A{round_}", f"B{round_}"]))
        assert sorted(code(r) for r in results) == ["ok", "version_conflict"]
        assert o.app.state.org.deadline_store.deadlines[d["id"]].version == v + 1


def test_duas_transferencias(env):
    o, oid, ana, bia, caio = env
    o.set_perms(ana, oid, bia, TRANSFER)
    p = create(o, bia, scope="personal")
    svc = o.app.state.deadlines
    barrier = threading.Barrier(2)

    def tr(_):
        barrier.wait()
        try:
            return svc.transfer(bia.id, p["id"], 1, oid)
        except Exception as exc:
            return exc

    with ThreadPoolExecutor(2) as pool:
        results = list(pool.map(tr, range(2)))
    # A segunda já encontra o prazo no escritório: regra de negócio antes da versão.
    assert sorted(code(r) for r in results) == ["not_transferable", "ok"]
    store = o.app.state.org.deadline_store
    assert len(store.deadlines) == 1 and len(store.history[p["id"]]) == 2   # um único "transferred"


def test_duas_remocoes_e_remocao_com_saida(env, org):
    o, oid, ana, bia, caio = env
    gil = o.person("gil")
    o.join(ana, oid, gil)
    o.service.promote(ana.id, oid, gil.id)
    create(o, ana, responsibleId=bia.id)
    barrier = threading.Barrier(3)

    def run(fn):
        barrier.wait()
        try:
            return fn()
        except Exception as exc:
            return exc

    with ThreadPoolExecutor(3) as pool:
        results = list(pool.map(run, [
            lambda: o.service.remove_member(ana.id, oid, bia.id, caio.id),
            lambda: o.service.remove_member(gil.id, oid, bia.id, caio.id),
            lambda: o.service.leave(bia.id, oid, None, caio.id),
        ]))
    assert [code(r) for r in results].count("ok") == 1
    assert all(code(r) == "not_found" for r in results if code(r) != "ok")
    assert o.membership(bia) is None
    history = [e for evs in o.app.state.org.deadline_store.history.values() for e in evs if e.action == "reassigned"]
    assert len(history) == 1                                            # uma única reatribuição
    invariant(o)


def test_estresse_criacao_reatribuicao_e_saida(env):
    """Barreira sem ordem forçada, várias rodadas: a invariante vale em qualquer intercalação."""
    o, oid, ana, bia, caio = env
    dsvc, osvc = o.app.state.deadlines, o.service
    for i in range(8):
        p = o.person()
        o.join(ana, oid, p)
        kind, data = _data(p.id)
        d = dsvc.create(ana.id, kind, data)
        barrier = threading.Barrier(3)

        def run(fn):
            barrier.wait()
            try:
                return fn()
            except Exception as exc:
                return exc

        with ThreadPoolExecutor(3) as pool:
            list(pool.map(run, [
                lambda p=p: osvc.leave(p.id, oid, None, caio.id),
                lambda p=p: dsvc.create(ana.id, kind, {**data, "responsible_id": p.id}),
                lambda d=d, p=p: dsvc.update(ana.id, d.id, d.version, {"responsible_id": p.id, "title": f"R{i}"}),
            ]))
        invariant(o)


def test_instante_obtido_apos_os_locks(env, clock):
    o, oid, ana, bia, caio = env
    d = create(o, ana)
    dsvc = o.app.state.deadlines
    hold = lambda: _org_in_unit(o, lambda: None)  # noqa: E731

    def complete():
        return dsvc.change_status(ana.id, d["id"], 1, "completed", None)

    gate = UnitGate(o, holder="first", waiter="second")
    out = {}
    t1 = _run("first", hold, out)
    assert gate.inside.wait(30)
    t2 = _run("second", complete, out)
    assert gate.about_to_lock.wait(30)
    clock.advance(600)
    gate.release.set()
    t1.join(30)
    t2.join(30)
    gate.close()
    assert out["second"].updated_at == clock.now()
    assert o.app.state.org.deadline_store.history[d["id"]][-1].at == clock.now()
