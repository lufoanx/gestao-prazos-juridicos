"""Etapa 5 — saída/remoção de membros com intimações pendentes (integração real em memória)."""
import pytest

from tests.deadline_utils import create
from tests.intimation_utils import ControlledProcessing, confirm, full_state, get_i, notifications, register
from tests.org_utils import API


@pytest.fixture
def env(org):
    o = org(processing_port=None)
    ana, bia, caio, dani = o.person("ana"), o.person("bia"), o.person("caio"), o.person("dani")
    oid = o.office(ana)
    for p in (bia, caio, dani):
        o.join(ana, oid, p)
    return o, oid, ana, bia, caio, dani


def remove(o, actor, oid, target, reassign=None):
    body = {"reassignTo": reassign.id} if reassign else {}
    return o.http.post(f"{API}/offices/{oid}/members/{target.id}/remove", headers=actor.headers, json=body)


def intim(o, iid):
    return o.app.state.org.unit_of_work.intimation_store.intimations[iid]


def test_pendentes_sugeridas_ou_criadas_sem_sugestao_exigem_reatribuicao(env):
    o, oid, ana, bia, caio, dani = env
    suggested = register(o, ana, suggestedResponsibleId=bia.id)
    orphan = register(o, bia)                                     # criada por bia, sem sugestão
    covered = register(o, bia, suggestedResponsibleId=bia.id)
    o.http.patch(f"{API}/intimations/{covered['id']}", headers=ana.headers,
                 json={"version": 1, "suggestedResponsibleId": dani.id})   # já tem outro sugerido ativo
    discarded = register(o, ana, suggestedResponsibleId=bia.id)
    o.http.post(f"{API}/intimations/{discarded['id']}/discard", headers=ana.headers, json={"version": 1})
    reviewed = register(o, ana, suggestedResponsibleId=bia.id)
    confirm(o, ana, reviewed["id"], 1, responsibleId=dani.id)
    r = remove(o, ana, oid, bia)
    assert r.status_code == 409 and r.json()["error"]["code"] == "reassign_required"
    assert remove(o, ana, oid, bia, caio).status_code == 204
    assert intim(o, suggested["id"]).suggested_responsible_id == caio.id
    assert intim(o, orphan["id"]).suggested_responsible_id == caio.id
    assert intim(o, orphan["id"]).created_by == bia.id                       # autoria histórica preservada
    assert intim(o, covered["id"]).suggested_responsible_id == dani.id       # não substituído
    assert intim(o, discarded["id"]).suggested_responsible_id == bia.id      # descartada fora da contagem
    assert intim(o, reviewed["id"]).suggested_responsible_id == bia.id       # revisada segue o prazo
    ev = o.app.state.org.unit_of_work.intimation_store.events[orphan["id"]][-1]
    assert ev.action == "responsible_reassigned" and ev.details["reason"] == "member_removed"
    assert ev.details["createdBy"] == bia.id
    assert get_i(o, caio, orphan["id"]).status_code == 200
    kinds = [n["kind"] for n in notifications(o, caio).json()["items"]]
    assert kinds.count("intimation_assigned") == 2


def test_estados_reservados_ao_processamento_tambem_contam(org):
    proc = ControlledProcessing()
    o = org(processing_port=proc)
    ana, bia, caio = o.person("ana"), o.person("bia"), o.person("caio")
    oid = o.office(ana)
    o.join(ana, oid, bia)
    o.join(ana, oid, caio)
    processing = register(o, bia)
    failed = register(o, bia)
    o.app.state.intimations.apply_processing_result(failed["id"], "failed")
    assert intim(o, processing["id"]).status == "processing" and intim(o, failed["id"]).status == "failed"
    assert remove(o, ana, oid, bia).json()["error"]["code"] == "reassign_required"
    assert remove(o, ana, oid, bia, caio).status_code == 204
    assert intim(o, processing["id"]).suggested_responsible_id == caio.id
    assert intim(o, failed["id"]).suggested_responsible_id == caio.id


def test_saida_com_intimacoes_pendentes(env):
    o, oid, ana, bia, caio, dani = env
    i = register(o, bia)
    r = o.http.post(f"{API}/offices/{oid}/leave", headers=bia.headers, json={})
    assert r.status_code == 409 and r.json()["error"]["code"] == "reassign_required"
    r = o.http.post(f"{API}/offices/{oid}/leave", headers=bia.headers, json={"reassignTo": dani.id})
    assert r.status_code == 204
    assert intim(o, i["id"]).suggested_responsible_id == dani.id
    assert o.app.state.org.unit_of_work.intimation_store.events[i["id"]][-1].details["reason"] == "member_left"
    assert get_i(o, bia, i["id"]).status_code == 404


def _fail(o, point):
    def fault(p):
        if p == point:
            raise RuntimeError(p)
    o.app.state.org.unit_of_work.fault = fault


@pytest.mark.parametrize("point", [
    "reassign:deadline", "reassign:history", "reassign:between",    # após prazos, antes das intimações
    "reassign:intimation", "notify",                                # após reatribuir intimação (inverso)
    "remove:before_delete", "unit:prepare", "unit:publish", "unit:publish:1", "unit:publish:2",
])
def test_falha_na_remocao_com_prazos_e_intimacoes_sem_efeito_parcial(env, point):
    o, oid, ana, bia, caio, dani = env
    create(o, ana, responsibleId=bia.id)
    register(o, bia)
    register(o, ana, suggestedResponsibleId=bia.id)
    before = full_state(o)
    _fail(o, point)
    r = remove(o, ana, oid, bia, caio)
    assert r.status_code == 500
    after = full_state(o)
    # Memória: referências intactas; PostgreSQL (sem referências): conteúdo integral idêntico.
    assert (after[0] is None or all(a is b for a, b in zip(after[0], before[0], strict=True))) and after[1] == before[1]
    o.app.state.org.unit_of_work.fault = None
    assert remove(o, ana, oid, bia, caio).status_code == 204


def test_revisao_concorrendo_com_saida_do_responsavel(env):
    from tests.test_deadlines_concurrency import invariant, ordered
    o, oid, ana, bia, caio, dani = env
    i = register(o, ana, suggestedResponsibleId=bia.id)
    from app.schemas.intimations import ConfirmIntimationRequest
    from tests.intimation_utils import confirm_body
    data = ConfirmIntimationRequest.model_validate(confirm_body(1, responsibleId=bia.id)).model_dump(
        exclude={"version"})
    svc, org_svc = o.app.state.intimations, o.service
    leave = lambda: org_svc.leave(bia.id, oid, None, caio.id)  # noqa: E731
    conf = lambda: svc.confirm(ana.id, i["id"], 1, data)  # noqa: E731
    r_leave, r_conf = ordered(o, leave, conf)
    assert getattr(r_leave, "code", "ok") == "ok"
    # bia saiu: a intimação foi reatribuída (versão 2) → a revisão com versão 1 não confirma às cegas.
    assert getattr(r_conf, "code", None) == "version_conflict"
    invariant(o)
