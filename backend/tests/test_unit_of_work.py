"""Etapa 4 — unidade de trabalho em memória: escritas preparadas, rollback real e publicação."""
from datetime import date, datetime, timezone

import pytest

from app.domain.deadlines import Deadline, Scope
from app.domain.org import ADMIN_PERMISSIONS, Membership, Office
from app.repositories.deadlines_memory import CapacityError, DeadlineLimits, MemoryDeadlineStore
from app.repositories.memory_tx import ConsistencyError
from app.repositories.org_memory import MemoryOrgStore
from app.repositories.unit_of_work import MemoryUnitOfWork
from tests.conftest import FakeClock

NOW = datetime(2026, 11, 9, 12, tzinfo=timezone.utc)


@pytest.fixture
def uow():
    org = MemoryOrgStore(closed_retention_seconds=86400)
    dl = MemoryDeadlineStore(DeadlineLimits(max_per_scope=2, max_comments_per_deadline=5, max_history_per_deadline=5))
    return MemoryUnitOfWork(org, dl)


def office(oid="o1"):
    return Office(oid, "Escritório", "u1", NOW, f"CODE{oid:>6}".replace(" ", "0")[:10])


def member(uid="u1", oid="o1"):
    return Membership(uid, oid, "Admin", (), ADMIN_PERMISSIONS, "all", NOW)


def deadline(did="d1", responsible="u1", oid="o1", status="open"):
    return Deadline(did, Scope.office(oid), "T", "123", "TJ", "Cível", responsible, status, "normal",
                    date(2026, 1, 1), date(2026, 1, 2), "business", 1, True, None, "u1", NOW, NOW)


class Boom(Exception):
    pass


def seed(uow):
    with uow.unit(FakeClock()) as tx:
        tx.org.put_office(office())
        tx.org.put_membership(member())
        tx.org.put_membership(member("u2"))
        tx.deadlines.put(deadline())


def test_excecao_no_corpo_descarta_tudo(uow):
    seed(uow)
    org_before, dl_before = uow.org_store.state, uow.deadline_store.state
    with pytest.raises(Boom):
        with uow.unit(FakeClock()) as tx:
            tx.org.delete_membership("u2")
            tx.deadlines.put(deadline("d2"))
            assert tx.org.membership_of_user("u2") is None          # a própria transação vê a escrita
            assert uow.org_store.membership_by_user.get("u2")       # o estado confirmado não
            raise Boom()
    assert uow.org_store.state is org_before and uow.deadline_store.state is dl_before


def test_falha_na_publicacao_restaura_as_duas_referencias(uow):
    seed(uow)
    org_before, dl_before = uow.org_store.state, uow.deadline_store.state

    def fault(point):
        if point == "unit:publish":                                 # depois de publicar escritórios
            raise Boom(point)
    uow.fault = fault
    with pytest.raises(Boom):
        with uow.unit(FakeClock()) as tx:
            tx.org.put_membership(member("u3"))
            tx.deadlines.put(deadline("d2"))
    assert uow.org_store.state is org_before and uow.deadline_store.state is dl_before


def test_capacidade_validada_antes_de_publicar_qualquer_parte(uow):
    seed(uow)
    org_before = uow.org_store.state
    with pytest.raises(CapacityError):
        with uow.unit(FakeClock()) as tx:
            tx.org.put_membership(member("u3"))                     # mudança de escritório preparada
            tx.deadlines.put(deadline("d2"))
            tx.deadlines.put(deadline("d3"))                        # 3 > max_per_scope=2
    assert uow.org_store.state is org_before


def test_invariante_de_responsavel_na_preparacao_final(uow):
    seed(uow)
    with pytest.raises(ConsistencyError):
        with uow.unit(FakeClock()) as tx:
            tx.deadlines.put(deadline("d2", responsible="fora"))
    with pytest.raises(ConsistencyError):
        with uow.unit(FakeClock()) as tx:
            tx.org.delete_membership("u1")                          # d1 em aberto com u1
    assert "u1" in uow.org_store.membership_by_user and "d2" not in uow.deadline_store.deadlines


def test_prazo_concluido_de_ex_membro_e_permitido(uow):
    seed(uow)
    with uow.unit(FakeClock()) as tx:
        tx.deadlines.put(deadline("d9", responsible="u2", status="completed"))
        tx.org.delete_membership("u2")
    assert "u2" not in uow.org_store.membership_by_user


def test_transacao_so_de_escritorios_nao_remove_vinculo(uow):
    seed(uow)
    with pytest.raises(RuntimeError):
        with uow.transaction(FakeClock()) as tx:
            tx.delete_membership("u2")
    assert "u2" in uow.org_store.membership_by_user


def test_transacao_so_de_escritorios_tambem_faz_rollback(uow):
    seed(uow)
    before = uow.org_store.state
    with pytest.raises(Boom):
        with uow.transaction(FakeClock()) as tx:
            tx.put_office(office("o2"))
            raise Boom()
    assert uow.org_store.state is before
    uow.fault = lambda point: (_ for _ in ()).throw(Boom()) if point == "org:prepare" else None
    with pytest.raises(Boom):
        with uow.transaction(FakeClock()) as tx:
            tx.put_office(office("o3"))
    assert uow.org_store.state is before


def test_indices_consistentes_apos_mudanca_de_escopo(uow):
    seed(uow)
    personal = Deadline("p1", Scope.personal("u1"), "T", "123", "TJ", "Cível", "u1", "open", "normal",
                        date(2026, 1, 1), date(2026, 1, 2), "business", 1, True, None, "u1", NOW, NOW)
    with uow.unit(FakeClock()) as tx:
        tx.deadlines.put(personal)
    from dataclasses import replace
    with uow.unit(FakeClock()) as tx:
        tx.deadlines.put(replace(personal, scope=Scope.office("o1")))
    idx = uow.deadline_store.by_scope
    assert "p:u1" not in idx and idx["o:o1"] == frozenset({"d1", "p1"})


def test_ordem_de_locks_unica(uow):
    """A unidade adquire escritórios → prazos; o lock de prazos nunca é obtido sozinho primeiro."""
    acquired = []

    class Spy:
        def __init__(self, name, inner):
            self.name, self.inner = name, inner

        def __enter__(self):
            acquired.append(self.name)
            return self.inner.__enter__()

        def __exit__(self, *a):
            return self.inner.__exit__(*a)

    uow.org_store.lock = Spy("org", uow.org_store.lock)
    uow.deadline_store.lock = Spy("deadlines", uow.deadline_store.lock)
    with uow.unit(FakeClock()):
        pass
    assert acquired == ["org", "deadlines"]
