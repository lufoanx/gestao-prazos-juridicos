"""Auditoria da Etapa 5 — (1) históricos não expõem IDs protegidos; (2) edição não recria órfã."""
from dataclasses import replace

import pytest

from app.repositories.memory_tx import ConsistencyError
from tests.deadline_utils import TRANSFER
from tests.intimation_utils import confirm, full_state, register
from tests.org_utils import API


@pytest.fixture
def env(org):
    """ana admin (all); bia e caio membros (assigned)."""
    o = org()
    ana, bia, caio = o.person("ana"), o.person("bia"), o.person("caio")
    oid = o.office(ana)
    o.join(ana, oid, bia)
    o.join(ana, oid, caio)
    return o, oid, ana, bia, caio


def history(o, who, iid):
    return o.http.get(f"{API}/intimations/{iid}/history", headers=who.headers)


# ======================================================================
# 1. Histórico com projeção autorizada
# ======================================================================
def test_autor_sem_leitura_do_prazo_nao_ve_id_no_historico(env):
    o, oid, ana, bia, caio = env
    i = register(o, bia)
    did = confirm(o, ana, i["id"], 1, responsibleId=caio.id).json()["deadline"]["id"]
    assert o.http.get(f"{API}/deadlines/{did}", headers=bia.headers).status_code == 404
    r = history(o, bia, i["id"])
    assert r.status_code == 200 and did not in r.text                     # JSON completo
    confirmed = [e for e in r.json()["items"] if e["action"] == "confirmed"][0]
    assert confirmed["details"] == {"deadlineId": None, "deadlineIdHidden": True}   # vínculo indicado
    assert did not in o.http.get(f"{API}/intimations/{i['id']}", headers=bia.headers).text


def test_com_leitura_autorizada_a_referencia_continua(env):
    o, oid, ana, bia, caio = env
    i = register(o, bia)
    did = confirm(o, ana, i["id"], 1, responsibleId=caio.id).json()["deadline"]["id"]
    for who in (ana, caio):
        confirmed = [e for e in history(o, who, i["id"]).json()["items"] if e["action"] == "confirmed"][0]
        assert confirmed["details"] == {"deadlineId": did}


def test_perda_e_recuperacao_de_acesso_com_o_mesmo_token(env):
    o, oid, ana, bia, caio = env
    i = register(o, bia)
    did = confirm(o, ana, i["id"], 1, responsibleId=bia.id).json()["deadline"]["id"]
    assert did in history(o, bia, i["id"]).text
    o.http.patch(f"{API}/deadlines/{did}", headers=ana.headers, json={"version": 1, "responsibleId": caio.id})
    assert did not in history(o, bia, i["id"]).text                        # mesmo token, perdeu leitura
    o.http.patch(f"{API}/deadlines/{did}", headers=ana.headers, json={"version": 2, "responsibleId": bia.id})
    assert did in history(o, bia, i["id"]).text                            # recuperou


def test_evento_de_transferencia_tambem_e_projetado(env):
    o, oid, ana, bia, caio = env
    o.set_perms(ana, oid, bia, TRANSFER)
    i = register(o, bia, scope="personal")
    did = confirm(o, bia, i["id"], 1).json()["deadline"]["id"]
    o.http.post(f"{API}/deadlines/{did}/transfer", headers=bia.headers,
                json={"version": 1, "officeId": oid, "confirmSharing": True, "shareLinkedIntimation": True})
    o.http.patch(f"{API}/deadlines/{did}", headers=ana.headers, json={"version": 2, "responsibleId": caio.id})
    r = history(o, bia, i["id"])                                           # autora; prazo agora de caio
    assert r.status_code == 200 and did not in r.text
    transferred = [e for e in r.json()["items"] if e["action"] == "transferred"][0]
    assert transferred["details"]["deadlineId"] is None and transferred["details"]["deadlineIdHidden"] is True
    assert transferred["details"]["toOfficeId"] == oid
    assert did in history(o, ana, i["id"]).text


def test_projecao_nao_altera_o_evento_armazenado(env):
    o, oid, ana, bia, caio = env
    i = register(o, bia)
    did = confirm(o, ana, i["id"], 1, responsibleId=caio.id).json()["deadline"]["id"]
    store = o.app.state.org.unit_of_work.intimation_store
    before = (store.state, store.events[i["id"]])
    history(o, bia, i["id"])
    assert store.state is before[0] and store.events[i["id"]] is before[1]
    assert store.events[i["id"]][-1].details == {"deadlineId": did}


def test_historico_do_prazo_usa_a_mesma_projecao(env):
    o, oid, ana, bia, caio = env
    i = register(o, ana)
    did = confirm(o, ana, i["id"], 1, responsibleId=caio.id).json()["deadline"]["id"]
    h = o.http.get(f"{API}/deadlines/{did}/history", headers=caio.headers).json()
    assert h["items"][0]["details"]["source"] == {"intimationId": i["id"]}  # caio lê a intimação revisada
    from app.services import deadline_ops as ops
    assert ops.PROTECTED_REFS == {"deadlineId": "deadline", "intimationId": "intimation",
                                  "linkedIntimationId": "intimation"}


# ======================================================================
# 2. Edição não pode recriar intimação órfã
# ======================================================================
def _patch(o, who, iid, **fields):
    v = o.http.get(f"{API}/intimations/{iid}", headers=who.headers).json()["version"]
    return o.http.patch(f"{API}/intimations/{iid}", headers=who.headers, json={"version": v, **fields})


def test_sequencia_da_auditoria_recusada_sem_efeito(env):
    o, oid, ana, bia, caio = env
    i = register(o, bia)                                                   # sem sugerido
    assert o.http.post(f"{API}/offices/{oid}/members/{bia.id}/remove", headers=ana.headers,
                       json={"reassignTo": caio.id}).status_code == 204
    before = full_state(o)
    r = _patch(o, caio, i["id"], suggestedResponsibleId=None)
    assert r.status_code == 409 and r.json()["error"]["code"] == "operational_responsible_required"
    after = full_state(o)
    assert all(a is b for a, b in zip(after[0], before[0], strict=True)) and after[1] == before[1]
    r = o.http.post(f"{API}/offices/{oid}/leave", headers=caio.headers, json={})
    assert r.status_code == 409 and r.json()["error"]["code"] == "reassign_required"   # ainda é responsável


def test_limpar_sugestao_com_autor_ativo_e_permitido(env):
    o, oid, ana, bia, caio = env
    i = register(o, ana, suggestedResponsibleId=caio.id)
    r = _patch(o, ana, i["id"], suggestedResponsibleId=None)
    assert r.status_code == 200 and r.json()["suggestedResponsibleId"] is None


def test_trocar_para_outro_sugerido_ativo_e_permitido(env):
    o, oid, ana, bia, caio = env
    i = register(o, bia)
    o.http.post(f"{API}/offices/{oid}/members/{bia.id}/remove", headers=ana.headers, json={"reassignTo": caio.id})
    r = _patch(o, ana, i["id"], suggestedResponsibleId=ana.id)
    assert r.status_code == 200 and r.json()["suggestedResponsibleId"] == ana.id
    r = _patch(o, ana, i["id"], suggestedResponsibleId="nao-membro")
    assert r.status_code == 422


def test_pessoal_e_terminais_fora_da_regra(env):
    o, oid, ana, bia, caio = env
    p = register(o, bia, scope="personal")
    assert _patch(o, bia, p["id"], title="Rascunho pessoal").status_code == 200
    i = register(o, bia)
    o.http.post(f"{API}/intimations/{i['id']}/discard", headers=bia.headers, json={"version": 1})
    assert o.http.post(f"{API}/offices/{oid}/members/{bia.id}/remove", headers=ana.headers,
                       json={}).status_code == 204                         # descartada não exige responsável


@pytest.mark.parametrize("patch_first", [True, False])
def test_patch_concorrendo_com_remocao_do_autor(env, patch_first):
    from tests.test_deadlines_concurrency import ordered
    o, oid, ana, bia, caio = env
    i = register(o, bia, suggestedResponsibleId=bia.id)
    _patch(o, ana, i["id"], suggestedResponsibleId=caio.id)                # versão 2, sugerido caio
    svc = o.app.state.intimations
    clear = lambda: svc.update_draft(ana.id, i["id"], 2, {}, None, True)  # noqa: E731
    remove = lambda: o.service.remove_member(ana.id, oid, bia.id, caio.id)  # noqa: E731
    if patch_first:
        r_patch, r_remove = ordered(o, clear, remove)
        assert getattr(r_patch, "code", "ok") == "ok" and getattr(r_remove, "code", "ok") == "ok"
        final = o.app.state.org.unit_of_work.intimation_store.intimations[i["id"]]
        assert final.suggested_responsible_id == caio.id                   # órfã reatribuída na remoção
    else:
        r_remove, r_patch = ordered(o, remove, clear)
        assert getattr(r_remove, "code", "ok") == "ok"
        assert getattr(r_patch, "code", None) == "operational_responsible_required"
        final = o.app.state.org.unit_of_work.intimation_store.intimations[i["id"]]
        assert final.suggested_responsible_id == caio.id and final.version == 2


def test_escrita_invalida_direta_barrada_na_preparacao_final(env):
    o, oid, ana, bia, caio = env
    i = register(o, bia)
    o.http.post(f"{API}/offices/{oid}/members/{bia.id}/remove", headers=ana.headers, json={"reassignTo": caio.id})
    uow = o.app.state.org.unit_of_work
    before = full_state(o)
    with pytest.raises(ConsistencyError):
        with uow.unit(o.app.state.auth.clock) as tx:
            tx.intimations.put(replace(tx.intimations.get(i["id"]), suggested_responsible_id=None))
    assert full_state(o)[1] == before[1]
