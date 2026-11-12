"""Etapa 5 — concorrência com ordem forçada (UnitGate) entre confirmação e outras operações."""
import pytest

from app.schemas.intimations import ConfirmIntimationRequest
from tests.intimation_utils import confirm_body, register
from tests.test_deadlines_concurrency import _org_in_unit, invariant, ordered


def code(r):
    return getattr(r, "code", "ok")


@pytest.fixture
def env(org):
    o = org()
    ana, bia, caio = o.person("ana"), o.person("bia"), o.person("caio")
    oid = o.office(ana)
    o.join(ana, oid, bia)
    o.join(ana, oid, caio)
    return o, oid, ana, bia, caio


def _data(**over):
    return ConfirmIntimationRequest.model_validate(confirm_body(1, **over)).model_dump(exclude={"version"})


@pytest.mark.parametrize("remove_first", [True, False])
def test_confirmacao_concorrendo_com_remocao_do_sugerido(env, remove_first):
    o, oid, ana, bia, caio = env
    i = register(o, ana, suggestedResponsibleId=bia.id)
    conf = lambda: o.app.state.intimations.confirm(ana.id, i["id"], 1, _data(responsibleId=bia.id))  # noqa: E731
    remove = lambda: o.service.remove_member(ana.id, oid, bia.id, caio.id)  # noqa: E731
    if remove_first:
        r_remove, r_conf = ordered(o, remove, conf)
        assert code(r_remove) == "ok" and code(r_conf) == "version_conflict"
    else:
        r_conf, r_remove = ordered(o, conf, remove)
        assert code(r_conf) == "ok" and code(r_remove) == "ok"
        d = o.app.state.org.deadline_store.deadlines[r_conf.deadline.id]
        assert d.responsible_id == caio.id                               # prazo criado foi reatribuído
    invariant(o)


@pytest.mark.parametrize("patch_first", [True, False])
def test_confirmacao_concorrendo_com_reatribuicao_da_sugestao(env, patch_first):
    o, oid, ana, bia, caio = env
    i = register(o, ana, suggestedResponsibleId=bia.id)
    svc = o.app.state.intimations
    conf = lambda: svc.confirm(ana.id, i["id"], 1, _data(responsibleId=bia.id))  # noqa: E731
    reassign = lambda: svc.update_draft(ana.id, i["id"], 1, {}, caio.id, True)  # noqa: E731
    first, second = (reassign, conf) if patch_first else (conf, reassign)
    r1, r2 = ordered(o, first, second)
    assert code(r1) == "ok" and code(r2) in ("version_conflict", "invalid_state")
    final = o.app.state.org.unit_of_work.intimation_store.intimations[i["id"]]
    assert (final.status == "reviewed") == (not patch_first)


@pytest.mark.parametrize("discard_first", [True, False])
def test_descarte_concorrendo_com_confirmacao(env, discard_first):
    o, oid, ana, bia, caio = env
    i = register(o, ana)
    svc = o.app.state.intimations
    conf = lambda: svc.confirm(ana.id, i["id"], 1, _data())  # noqa: E731
    discard = lambda: svc.discard(ana.id, i["id"], 1)  # noqa: E731
    first, second = (discard, conf) if discard_first else (conf, discard)
    r1, r2 = ordered(o, first, second)
    assert code(r1) == "ok" and code(r2) in ("invalid_state", "version_conflict")
    store = o.app.state.org.unit_of_work.intimation_store
    assert store.intimations[i["id"]].status == ("discarded" if discard_first else "reviewed")
    assert len(o.app.state.org.deadline_store.deadlines) == (0 if discard_first else 1)


@pytest.mark.memory_only(
    "ordena as threads pelo RLock reentrante da memória; equivalente SQL: "
    "test_domain_sql_concurrency::test_perda_de_permissao_concorrendo_com_confirmacao_sql"
)
def test_perda_de_permissao_concorrendo_com_confirmacao(env):
    o, oid, ana, bia, caio = env
    i = register(o, bia)
    demote = lambda: o.service.update_member(ana.id, oid, bia.id, permissions=frozenset({"deadline.read"}))  # noqa: E731
    conf = lambda: o.app.state.intimations.confirm(bia.id, i["id"], 1, _data())  # noqa: E731
    r_demote, r_conf = ordered(o, lambda: _org_in_unit(o, demote), conf)
    assert code(r_demote) == "ok" and code(r_conf) == "forbidden"
    assert o.app.state.org.deadline_store.deadlines == {}
