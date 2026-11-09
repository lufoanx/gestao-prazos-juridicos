"""Etapa 4 — integração REAL (em memória) entre remoção/saída de membros e prazos.

Inclui rollback com falhas injetadas DEPOIS de escritas preparadas (reatribuição,
histórico, promoção do sucessor, remoção do vínculo, preparação final e publicação),
conferindo o estado integral dos dois módulos e seus índices.
"""
import pytest

from tests.deadline_utils import EDITOR, create, get, listing, set_status, snapshot
from tests.org_utils import API

MANAGER = EDITOR + ["team.manage"]


@pytest.fixture
def env(org):
    """ana admin; gil gestor; bia e caio membros. Prazos: 2 abertos, 1 concluído, 1 cancelado de bia;
    1 aberto de caio; 1 pessoal de bia."""
    o = org()
    ana, gil, bia, caio = o.person("ana"), o.person("gil"), o.person("bia"), o.person("caio")
    oid = o.office(ana)
    for p in (gil, bia, caio):
        o.join(ana, oid, p)
    o.set_perms(ana, oid, gil, MANAGER)
    d = {
        "open1": create(o, ana, responsibleId=bia.id, title="Aberto 1"),
        "open2": create(o, ana, responsibleId=bia.id, title="Aberto 2"),
        "done": create(o, ana, responsibleId=bia.id, title="Concluído"),
        "cancel": create(o, ana, responsibleId=bia.id, title="Cancelado"),
        "caio": create(o, ana, responsibleId=caio.id, title="Do Caio"),
        "personal": create(o, bia, scope="personal", title="Pessoal da Bia"),
    }
    set_status(o, ana, d["done"]["id"], 1, "completed")
    set_status(o, ana, d["cancel"]["id"], 1, "cancelled")
    return o, oid, ana, gil, bia, caio, d


def _remove(o, actor, oid, target, reassign=None):
    body = {"reassignTo": reassign.id} if reassign else {}
    return o.http.post(f"{API}/offices/{oid}/members/{target.id}/remove", headers=actor.headers, json=body)


def _leave(o, actor, oid, successor=None, reassign=None):
    body = {}
    if successor:
        body["successorUserId"] = successor.id
    if reassign:
        body["reassignTo"] = reassign.id
    return o.http.post(f"{API}/offices/{oid}/leave", headers=actor.headers, json=body)


def _deadline(o, did):
    return o.app.state.org.deadline_store.deadlines[did]


def test_remocao_reatribui_somente_abertos_do_escritorio(env):
    o, oid, ana, gil, bia, caio, d = env
    r = _remove(o, ana, oid, bia)
    assert r.status_code == 409 and r.json()["error"]["code"] == "reassign_required"
    assert o.membership(bia) is not None
    assert _remove(o, ana, oid, bia, caio).status_code == 204
    assert o.membership(bia) is None
    assert _deadline(o, d["open1"]["id"]).responsible_id == caio.id
    assert _deadline(o, d["open2"]["id"]).responsible_id == caio.id
    assert _deadline(o, d["open1"]["id"]).version == 2
    assert _deadline(o, d["done"]["id"]).responsible_id == bia.id         # histórico preservado
    assert _deadline(o, d["cancel"]["id"]).responsible_id == bia.id
    assert _deadline(o, d["personal"]["id"]).scope.owner_id == bia.id     # pessoal intocado
    ev = o.app.state.org.deadline_store.history[d["open1"]["id"]][-1]
    assert ev.action == "reassigned" and ev.actor_id == ana.id
    assert ev.details == {"fromResponsibleId": bia.id, "toResponsibleId": caio.id, "reason": "member_removed"}


def test_ex_membro_perde_acesso_imediatamente_e_mantem_o_pessoal(env):
    o, oid, ana, gil, bia, caio, d = env
    _remove(o, ana, oid, bia, caio)
    assert get(o, bia, d["open1"]["id"]).status_code == 404               # mesmo token
    assert listing(o, bia).status_code == 404
    assert get(o, bia, d["personal"]["id"]).status_code == 200
    assert listing(o, bia, scope="personal").json()["total"] == 1


def test_destino_da_reatribuicao_validado(env, org):
    o, oid, ana, gil, bia, caio, d = env
    zed = o.person("zed")
    o.office(zed, "Outro")
    before = snapshot(o)
    for dest in (bia, zed):
        r = _remove(o, ana, oid, bia, dest)
        assert r.status_code == 409 and r.json()["error"]["code"] == "reassign_required"
    assert snapshot(o)[2:] == before[2:]


def test_reatribuicao_administrativa_nao_exige_deadline_edit(env):
    o, oid, ana, gil, bia, caio, d = env
    o.set_perms(ana, oid, gil, ["deadline.read", "team.manage"])          # gil sem deadline.edit
    assert _remove(o, gil, oid, bia, caio).status_code == 204


def test_saida_com_reatribuicao_e_sucessor(env):
    o, oid, ana, gil, bia, caio, d = env
    r = _leave(o, bia, oid)
    assert r.status_code == 409 and r.json()["error"]["code"] == "reassign_required"
    assert _leave(o, bia, oid, reassign=caio).status_code == 204
    assert _deadline(o, d["open1"]["id"]).responsible_id == caio.id
    assert o.app.state.org.deadline_store.history[d["open1"]["id"]][-1].details["reason"] == "member_left"
    # ana (última admin) com prazo em aberto: sucessor + reatribuição numa só unidade
    mine = create(o, ana, title="Da Ana")
    assert _leave(o, ana, oid, reassign=caio).json()["error"]["code"] == "successor_required"
    assert _leave(o, ana, oid, successor=gil).json()["error"]["code"] == "reassign_required"
    assert _leave(o, ana, oid, successor=gil, reassign=gil).status_code == 204
    assert o.membership(gil).is_admin and o.membership(ana) is None
    assert _deadline(o, mine["id"]).responsible_id == gil.id


def test_membro_sem_prazos_sai_sem_reatribuicao(env):
    o, oid, ana, gil, bia, caio, d = env
    assert _leave(o, gil, oid).status_code == 204


# ---------- rollback com falhas injetadas ----------
class Boom(RuntimeError):
    pass


def _fail_at(o, name, nth=1):
    seen = {"n": 0}

    def fault(point):
        if point == name:
            seen["n"] += 1
            if seen["n"] == nth:
                raise Boom(point)
    o.app.state.org.unit_of_work.fault = fault
    return seen


@pytest.mark.parametrize("point,nth", [
    ("reassign:deadline", 1), ("reassign:history", 1), ("reassign:deadline", 2), ("reassign:history", 2),
    ("remove:before_delete", 1), ("remove:after_delete", 1), ("unit:prepare", 1), ("unit:publish", 1),
])
def test_remocao_falha_em_qualquer_ponto_sem_efeito_parcial(env, point, nth):
    o, oid, ana, gil, bia, caio, d = env
    before = snapshot(o)
    seen = _fail_at(o, point, nth)
    r = _remove(o, ana, oid, bia, caio)
    assert seen["n"] >= nth
    assert r.status_code == 500 and r.json() == {"error": {"code": "internal_error", "message": "Erro interno."}}
    after = snapshot(o)
    assert after[0] is before[0] and after[1] is before[1]              # referências confirmadas intactas
    assert after[2:] == before[2:]                                      # dados e índices idênticos
    o.app.state.org.unit_of_work.fault = None
    assert _remove(o, ana, oid, bia, caio).status_code == 204           # operação válida depois


@pytest.mark.parametrize("point", [
    "reassign:deadline", "reassign:history", "leave:after_promote", "leave:after_delete", "unit:prepare",
    "unit:publish",
])
def test_saida_do_ultimo_admin_falha_sem_promover_nem_reatribuir(env, point):
    o, oid, ana, gil, bia, caio, d = env
    create(o, ana, title="Da Ana")
    before = snapshot(o)
    _fail_at(o, point)
    r = _leave(o, ana, oid, successor=gil, reassign=caio)
    assert r.status_code == 500
    after = snapshot(o)
    assert after[0] is before[0] and after[1] is before[1] and after[2:] == before[2:]
    assert not o.membership(gil).is_admin and o.membership(ana).is_admin


def test_porta_defeituosa_e_barrada_pela_invariante(org):
    """Uma porta que 'esquece' de reatribuir não consegue deixar prazo aberto com ex-membro."""
    class LazyPort:
        def count_open(self, tx, office_id, user_id):
            return len(tx.deadlines.open_in_office_for(office_id, user_id))

        def reassign_open(self, tx, office_id, from_user_id, to_user_id, actor_id, reason):
            return 0                                                    # bug simulado

    o = org(responsibility_port=LazyPort())
    ana, bia, caio = o.person("ana"), o.person("bia"), o.person("caio")
    oid = o.office(ana)
    o.join(ana, oid, bia)
    o.join(ana, oid, caio)
    did = create(o, ana, responsibleId=bia.id)["id"]
    before = snapshot(o)
    r = _remove(o, ana, oid, bia, caio)
    assert r.status_code == 500                                         # ConsistencyError
    assert snapshot(o)[2:] == before[2:] and o.membership(bia) is not None
    assert _deadline(o, did).responsible_id == bia.id


def test_limite_de_historico_na_reatribuicao_bloqueia_tudo(org):
    o = org(DEADLINES_MAX_HISTORY=10)
    ana, bia, caio = o.person("ana"), o.person("bia"), o.person("caio")
    oid = o.office(ana)
    o.join(ana, oid, bia)
    o.join(ana, oid, caio)
    ok = create(o, ana, responsibleId=bia.id, title="Folgado")
    full = create(o, ana, responsibleId=bia.id, title="Cheio")
    v = 1
    for i in range(9):                                                  # 1 + 9 = 10 eventos
        v = o.http.patch(f"{API}/deadlines/{full['id']}", headers=ana.headers,
                         json={"version": v, "title": f"Cheio {i}"}).json()["version"]
    before = snapshot(o)
    r = _remove(o, ana, oid, bia, caio)
    assert r.status_code == 409 and r.json()["error"]["code"] == "history_limit_reached"
    assert snapshot(o)[2:] == before[2:]
    assert _deadline(o, ok["id"]).responsible_id == bia.id              # nem o prazo "folgado" mudou
