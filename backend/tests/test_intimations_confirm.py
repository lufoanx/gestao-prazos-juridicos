"""Etapa 5 — confirmação: versão, dados explícitos, idempotência, concorrência e rollback."""
import threading
from concurrent.futures import ThreadPoolExecutor

import pytest

from tests.deadline_utils import TRANSFER
from tests.intimation_utils import confirm, confirm_body, full_state, get_i, notifications, register
from tests.org_utils import API


@pytest.fixture
def env(org):
    o = org()
    ana, bia, caio, zed = o.person("ana"), o.person("bia"), o.person("caio"), o.person("zed")
    oid = o.office(ana)
    o.join(ana, oid, bia)
    o.join(ana, oid, caio)
    o.office(zed, "Outro")
    return o, oid, ana, bia, caio, zed


def stores(o):
    uow = o.app.state.org.unit_of_work
    return uow.deadline_store, uow.intimation_store, uow.notification_store


def test_primeira_confirmacao_cria_prazo_vinculo_historicos_e_notificacao(env):
    o, oid, ana, bia, *_ = env
    i = register(o, ana, suggestedResponsibleId=bia.id)
    r = confirm(o, ana, i["id"], 1, responsibleId=bia.id, agendaTime="09:00")
    assert r.status_code == 201 and r.json()["created"] is True
    body = r.json()
    did = body["deadline"]["id"]
    assert body["intimation"]["status"] == "reviewed" and body["intimation"]["deadlineId"] == did
    assert body["intimation"]["version"] == 2 and body["deadline"]["reviewed"] is True
    dl, it, nt = stores(o)
    assert it.by_deadline[did] == i["id"]
    assert dl.history[did][0].details["source"] == {"intimationId": i["id"]}
    assert [e.action for e in it.events[i["id"]]] == ["registered", "confirmed"]
    kinds = sorted(n["kind"] for n in notifications(o, bia).json()["items"])
    assert kinds == ["deadline_assigned", "intimation_assigned"]


def test_confirmacao_exige_versao_e_todos_os_dados(env):
    o, oid, ana, *_ = env
    i = register(o, ana)
    o.http.patch(f"{API}/intimations/{i['id']}", headers=ana.headers,
                 json={"version": 1, "title": "Título do rascunho", "court": "TJ"})
    body = confirm_body(2)
    for missing in ("version", "title", "caseNumber", "court", "practiceArea", "startDate", "dueDate",
                    "countingMode", "duration"):
        partial = {k: v for k, v in body.items() if k != missing}
        r = o.http.post(f"{API}/intimations/{i['id']}/confirm", headers=ana.headers, json=partial)
        assert r.status_code == 422, missing                                # não completa pelo rascunho
    for extra in ({"reviewed": False}, {"scope": "personal"}, {"deadlineId": "x"}, {"status": "open"}):
        r = o.http.post(f"{API}/intimations/{i['id']}/confirm", headers=ana.headers, json={**body, **extra})
        assert r.status_code == 422
    r = confirm(o, ana, i["id"], 1)
    assert r.status_code == 409 and r.json()["error"]["code"] == "version_conflict"
    assert stores(o)[0].deadlines == {}


def test_confirmacao_aplica_regras_da_etapa4(env):
    o, oid, ana, bia, caio, zed = env
    i = register(o, bia)
    r = confirm(o, bia, i["id"], 1, responsibleId=caio.id)                 # assigned → outro
    assert r.status_code == 403 and r.json()["error"]["code"] == "delegation_not_allowed"
    r = confirm(o, ana, i["id"], 1, responsibleId=zed.id)                  # fora do escritório
    assert r.status_code == 422 and r.json()["error"]["code"] == "responsible_invalid"
    r = confirm(o, ana, i["id"], 1, dueDate="2026-11-01")
    assert r.status_code == 422
    assert get_i(o, ana, i["id"]).json()["status"] == "awaiting_review"
    assert stores(o)[0].deadlines == {}


def test_repeticao_retorna_200_sem_efeito_mesmo_com_versao_antiga(env):
    o, oid, ana, bia, *_ = env
    i = register(o, ana)
    first = confirm(o, ana, i["id"], 1)
    before = full_state(o)
    again = confirm(o, ana, i["id"], 1, title="Outros dados")              # versão antiga, payload diferente
    assert again.status_code == 200 and again.json()["created"] is False
    assert again.json()["deadline"]["id"] == first.json()["deadline"]["id"]
    assert again.json()["deadline"]["title"] == "Contestação"
    assert full_state(o)[1] == before[1]                                   # nenhum novo efeito


def test_repeticao_sem_acesso_ao_prazo_ou_a_intimacao(env):
    o, oid, ana, bia, caio, zed = env
    i = register(o, bia)                                                   # bia é autora
    confirm(o, ana, i["id"], 1, responsibleId=caio.id)
    r = confirm(o, bia, i["id"], 1)                                        # lê a intimação, não o prazo
    assert r.status_code == 409 and r.json() == {
        "error": {"code": "already_reviewed", "message": "A intimação já foi revisada."}}
    r = confirm(o, zed, i["id"], 1)                                        # nem a intimação
    assert r.status_code == 404 and r.json() == confirm(o, zed, "inexistente", 1).json()
    o.set_perms(ana, oid, bia, ["deadline.read"])                          # lê, sem deadline.create
    assert confirm(o, bia, i["id"], 1).status_code == 403


def test_confirmacoes_concorrentes_criam_um_unico_prazo(env):
    o, oid, ana, bia, *_ = env
    svc = o.app.state.intimations
    for _ in range(5):
        i = register(o, ana)
        barrier = threading.Barrier(6)
        from app.schemas.intimations import ConfirmIntimationRequest
        parsed = ConfirmIntimationRequest.model_validate(confirm_body(1)).model_dump(exclude={"version"})

        def run(_):
            barrier.wait()
            try:
                return svc.confirm(ana.id, i["id"], 1, dict(parsed))
            except Exception as exc:
                return exc

        with ThreadPoolExecutor(6) as pool:
            results = list(pool.map(run, range(6)))
        created = [r for r in results if not isinstance(r, Exception) and r.created]
        repeats = [r for r in results if not isinstance(r, Exception) and not r.created]
        assert len(created) == 1 and len(repeats) == 5
        linked = [d for d in stores(o)[0].deadlines.values() if stores(o)[1].by_deadline.get(d.id) == i["id"]]
        assert len(linked) == 1


@pytest.mark.parametrize("patch_first", [True, False])
def test_patch_concorrendo_com_confirmacao(env, patch_first):
    """Uma revisão desatualizada não confirma silenciosamente dados sobre uma versão nova."""
    from tests.test_deadlines_concurrency import ordered
    o, oid, ana, bia, *_ = env
    i = register(o, ana)
    svc = o.app.state.intimations
    from app.schemas.intimations import ConfirmIntimationRequest
    data = ConfirmIntimationRequest.model_validate(confirm_body(1)).model_dump(exclude={"version"})
    do_patch = lambda: svc.update_draft(ana.id, i["id"], 1, {"title": "Mudou depois"}, None, False)  # noqa: E731
    do_confirm = lambda: svc.confirm(ana.id, i["id"], 1, data)  # noqa: E731
    if patch_first:
        r_patch, r_confirm = ordered(o, do_patch, do_confirm)
        assert getattr(r_confirm, "code", None) == "version_conflict"
        assert stores(o)[0].deadlines == {}
    else:
        r_confirm, r_patch = ordered(o, do_confirm, do_patch)
        assert r_confirm.created and getattr(r_patch, "code", None) == "version_conflict"


def _fail(o, point, nth=1):
    seen = {"n": 0}

    def fault(p):
        if p == point:
            seen["n"] += 1
            if seen["n"] == nth:
                raise RuntimeError(p)
    o.app.state.org.unit_of_work.fault = fault
    return seen


@pytest.mark.parametrize("point,nth", [
    ("notify", 1), ("confirm:deadline", 1), ("confirm:intimation", 1), ("confirm:event", 1),
    ("unit:prepare", 1), ("unit:publish", 1), ("unit:publish:1", 1), ("unit:publish:2", 1),
])
def test_falha_em_cada_fase_da_confirmacao_sem_efeito_parcial(env, point, nth):
    o, oid, ana, bia, *_ = env
    i = register(o, ana, suggestedResponsibleId=bia.id)
    before = full_state(o)
    seen = _fail(o, point, nth)
    r = confirm(o, ana, i["id"], 1, responsibleId=bia.id)
    assert seen["n"] >= nth and r.status_code == 500
    after = full_state(o)
    assert all(a is b for a, b in zip(after[0], before[0], strict=True))   # referências intactas
    assert after[1] == before[1]                                           # dados e índices idênticos
    o.app.state.org.unit_of_work.fault = None
    assert confirm(o, ana, i["id"], 1, responsibleId=bia.id).status_code == 201


def test_transferencia_com_intimacao_vinculada(env):
    o, oid, ana, bia, *_ = env
    o.set_perms(ana, oid, bia, TRANSFER)
    i = register(o, bia, scope="personal")
    did = confirm(o, bia, i["id"], 1).json()["deadline"]["id"]
    url = f"{API}/deadlines/{did}/transfer"
    base = {"version": 1, "officeId": oid, "confirmSharing": True}
    before = full_state(o)
    r = o.http.post(url, headers=bia.headers, json=base)
    assert r.status_code == 409 and r.json()["error"]["code"] == "linked_intimation_requires_consent"
    for bad in (1, "true", None):
        r = o.http.post(url, headers=bia.headers, json={**base, "shareLinkedIntimation": bad})
        assert r.status_code == 422, bad
    assert o.http.post(url, headers=bia.headers, json={**base, "confirmSharing": 1,
                                                       "shareLinkedIntimation": True}).status_code == 422
    assert full_state(o)[1] == before[1]                                   # nenhuma alteração parcial
    r = o.http.post(url, headers=bia.headers, json={**base, "shareLinkedIntimation": True})
    assert r.status_code == 200
    dl, it, _ = stores(o)
    moved = it.intimations[i["id"]]
    assert moved.scope.kind == "office" and moved.scope.office_id == oid and moved.created_by == bia.id
    assert dl.deadlines[did].scope == moved.scope and it.by_deadline[did] == i["id"]
    assert it.events[i["id"]][-1].action == "transferred"
    assert get_i(o, ana, i["id"]).status_code == 200                       # agora compartilhada


@pytest.mark.parametrize("point", ["transfer:deadline", "transfer:intimation", "unit:publish:1"])
def test_falha_na_transferencia_com_vinculo_sem_efeito_parcial(env, point):
    o, oid, ana, bia, *_ = env
    o.set_perms(ana, oid, bia, TRANSFER)
    i = register(o, bia, scope="personal")
    did = confirm(o, bia, i["id"], 1).json()["deadline"]["id"]
    before = full_state(o)
    _fail(o, point)
    r = o.http.post(f"{API}/deadlines/{did}/transfer", headers=bia.headers,
                    json={"version": 1, "officeId": oid, "confirmSharing": True, "shareLinkedIntimation": True})
    assert r.status_code == 500 and full_state(o)[1] == before[1]
