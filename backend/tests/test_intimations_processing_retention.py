"""Etapa 5 — processamento futuro (adaptador CONTROLADO), retenção, capacidade e invariantes."""
from dataclasses import replace

import pytest

from app.repositories.memory_tx import ConsistencyError
from tests.intimation_utils import ControlledProcessing, confirm, get_i, register
from tests.org_utils import API

DAY = 24 * 3600


# ---------- processamento (preparado; NÃO é processamento funcional) ----------
def test_adaptador_controlado_percorre_os_estados_reservados(org):
    proc = ControlledProcessing()
    o = org(processing_port=proc)
    ana = o.person("ana")
    o.office(ana)
    i = register(o, ana)
    assert i["status"] == "processing" and i["processing"]["status"] == "pending"
    assert proc.requested == [i["id"]]                               # pedido só após o commit
    svc = o.app.state.intimations
    svc.apply_processing_result(i["id"], "failed", failure_code="timeout")
    failed = get_i(o, ana, i["id"]).json()
    assert failed["status"] == "failed" and failed["processing"]["failureCode"] == "timeout"
    r = o.http.post(f"{API}/intimations/{i['id']}/retry", headers=ana.headers, json={"version": failed["version"]})
    assert r.status_code == 200 and r.json()["status"] == "processing" and proc.requested == [i["id"]] * 2
    svc.apply_processing_result(i["id"], "completed", fields={"title": "Sugestão"})
    done = get_i(o, ana, i["id"]).json()
    assert done["status"] == "awaiting_review" and done["suggestion"] == {"source": "processing",
                                                                         "fields": {"title": "Sugestão"}}
    assert done["draft"]["title"] is None                            # sugestão não vira rascunho nem prazo
    assert o.app.state.org.deadline_store.deadlines == {}            # revisão humana continua obrigatória
    with pytest.raises(Exception):
        svc.apply_processing_result(i["id"], "completed")            # fora de "processing"


@pytest.mark.memory_only(
    "injeta estado reservado no armazenamento em memória; equivalente SQL: "
    "test_domain_sql_equivalents::test_retry_sem_processamento_disponivel_sql"
)
def test_retry_sem_processamento_disponivel(org):
    o = org()
    ana = o.person("ana")
    o.office(ana)
    i = register(o, ana)
    store = o.app.state.org.unit_of_work.intimation_store
    with store.lock:                                                 # estado reservado injetado
        store.state.intimations[i["id"]] = replace(store.state.intimations[i["id"]], status="failed")
    r = o.http.post(f"{API}/intimations/{i['id']}/retry", headers=ana.headers, json={"version": 1})
    assert r.status_code == 409 and r.json()["error"]["code"] == "processing_unavailable"


# ---------- retenção e capacidade ----------
@pytest.mark.memory_only(
    "retenção (expurgo) — no PostgreSQL é da P5; sem equivalente nesta entrega"
)
def test_descartadas_removidas_com_eventos_e_indices_apos_retencao(org, clock):
    o = org(INTIMATIONS_DISCARD_RETENTION_SECONDS=DAY)
    ana = o.person("ana")
    o.office(ana)
    gone = register(o, ana)
    keep = register(o, ana)
    o.http.post(f"{API}/intimations/{gone['id']}/discard", headers=ana.headers, json={"version": 1})
    store = o.app.state.org.unit_of_work.intimation_store
    clock.advance(DAY)
    o.relogin(ana)
    o.http.get(f"{API}/intimations?scope=office", headers=ana.headers)    # unidade dispara a limpeza
    assert set(store.intimations) == {keep["id"]} and gone["id"] not in store.events
    assert all(gone["id"] not in ids for ids in store.by_scope.values())


def test_limite_de_intimacoes_por_ambiente(org):
    o = org(INTIMATIONS_MAX_PER_SCOPE=2)
    ana = o.person("ana")
    register(o, ana, scope="personal")
    register(o, ana, scope="personal")
    r = o.http.post(f"{API}/intimations", headers=ana.headers,
                    json={"scope": "personal", "fileName": "c.pdf", "sizeBytes": 1, "contentType": "application/pdf",
                          "receivedAt": "2026-11-09"})
    assert r.status_code == 409 and r.json()["error"]["code"] == "intimation_limit_reached"


def test_limite_de_historico_da_intimacao(org):
    o = org(INTIMATIONS_MAX_EVENTS=10)
    ana = o.person("ana")
    o.office(ana)
    i = register(o, ana)
    v = 1
    for k in range(9):
        v = o.http.patch(f"{API}/intimations/{i['id']}", headers=ana.headers,
                         json={"version": v, "title": f"Título {k}"}).json()["version"]
    r = o.http.patch(f"{API}/intimations/{i['id']}", headers=ana.headers, json={"version": v, "title": "Excedente"})
    assert r.status_code == 409 and r.json()["error"]["code"] == "intimation_history_limit_reached"
    assert get_i(o, ana, i["id"]).json()["draft"]["title"] == "Título 8"


@pytest.mark.parametrize("var,value", [
    ("INTIMATIONS_DISCARD_RETENTION_SECONDS", "60"), ("NOTIFICATIONS_MAX_PER_RECIPIENT", "5"),
    ("NOTIFICATIONS_READ_RETENTION_SECONDS", "0"), ("INTIMATIONS_MAX_EVENTS", "1"),
])
def test_configuracoes_invalidas(make_app, var, value):
    with pytest.raises(Exception):
        make_app(**{var: value})


# ---------- invariantes na preparação final ----------
def _uow(o):
    return o.app.state.org.unit_of_work


@pytest.mark.memory_only(
    "escreve estado inválido direto na transação em memória; no PostgreSQL a constraint recusa ANTES "
    "(equivalente: test_domain_sql_equivalents::test_escritas_invalidas_diretas_recusadas_pelo_banco e "
    "test_db_schema)"
)
def test_invariante_vinculo_unico_e_reciproco(org):
    o = org()
    ana = o.person("ana")
    o.office(ana)
    a = register(o, ana)
    b = register(o, ana)
    did = confirm(o, ana, a["id"], 1).json()["deadline"]["id"]
    uow = _uow(o)
    with pytest.raises(ConsistencyError):                              # segundo vínculo para o mesmo prazo
        with uow.unit(o.app.state.auth.clock) as tx:
            i = tx.intimations.get(b["id"])
            tx.intimations.put(replace(i, status="reviewed", deadline_id=did))
    with pytest.raises(ConsistencyError):                              # revisada sem vínculo
        with uow.unit(o.app.state.auth.clock) as tx:
            tx.intimations.put(replace(tx.intimations.get(b["id"]), status="reviewed"))
    with pytest.raises(ConsistencyError):                              # vínculo para prazo inexistente
        with uow.unit(o.app.state.auth.clock) as tx:
            tx.intimations.put(replace(tx.intimations.get(b["id"]), status="reviewed", deadline_id="nao-existe"))


def test_invariante_mesmo_ambiente(org):
    o = org()
    ana = o.person("ana")
    o.office(ana)
    i = register(o, ana, scope="personal")
    did = confirm(o, ana, i["id"], 1).json()["deadline"]["id"]
    uow = _uow(o)
    from app.domain.deadlines import Scope
    with pytest.raises(ConsistencyError):
        with uow.unit(o.app.state.auth.clock) as tx:
            d = tx.deadlines.get(did)
            tx.deadlines.put(replace(d, scope=Scope.office(tx.org.membership_of_user(ana.id).office_id)))


@pytest.mark.memory_only(
    "escreve estado inválido direto na transação em memória; equivalente SQL: "
    "test_domain_sql_equivalents::test_escritas_invalidas_diretas_recusadas_pelo_banco"
)
def test_invariante_sugerido_fora_do_escritorio(org):
    o = org()
    ana = o.person("ana")
    o.office(ana)
    i = register(o, ana)
    with pytest.raises(ConsistencyError):
        with _uow(o).unit(o.app.state.auth.clock) as tx:
            tx.intimations.put(replace(tx.intimations.get(i["id"]), suggested_responsible_id="fora"))


@pytest.mark.memory_only(
    "compara identidade do estado em memória; equivalente SQL: "
    "test_domain_sql_equivalents::test_rollback_restaura_exclusoes_da_caixa_sql"
)
def test_rollback_inclui_exclusoes_da_caixa(org, clock):
    """Se a operação falhar, as notificações removidas pela política da caixa voltam intactas."""
    o = org(NOTIFICATIONS_MAX_PER_RECIPIENT=10)
    ana, bia = o.person("ana"), o.person("bia")
    oid = o.office(ana)
    o.join(ana, oid, bia)
    from tests.deadline_utils import create
    for k in range(10):
        clock.advance(1)
        create(o, ana, responsibleId=bia.id, title=f"Prazo {k:02d}")
    o.relogin(ana)
    store = _uow(o).notification_store
    before = (store.state, dict(store.notifications))

    def fault(point):
        if point == "unit:prepare":
            raise RuntimeError(point)
    _uow(o).fault = fault
    r = o.http.post(f"{API}/deadlines", headers=ana.headers,
                    json={"scope": "office", "title": "Excedente", "caseNumber": "123", "court": "TJ",
                          "practiceArea": "Cível", "startDate": "2026-11-09", "dueDate": "2026-11-10",
                          "countingMode": "business", "duration": 1, "responsibleId": bia.id})
    assert r.status_code == 500
    assert store.state is before[0] and dict(store.notifications) == before[1] and len(store.notifications) == 10
