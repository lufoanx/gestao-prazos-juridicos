"""Etapa 5 — intimações: registro de metadados, leitura, isolamento, rascunho, descarte e retry."""
import pytest

from tests.intimation_utils import confirm, get_i, reg_body, register
from tests.org_utils import API


@pytest.fixture
def env(org):
    """ana admin (all); bia, caio membros (assigned); zed com outro escritório."""
    o = org()
    ana, bia, caio, zed = o.person("ana"), o.person("bia"), o.person("caio"), o.person("zed")
    oid = o.office(ana)
    o.join(ana, oid, bia)
    o.join(ana, oid, caio)
    o.office(zed, "Outro")
    return o, oid, ana, bia, caio, zed


def patch(o, who, iid, version, **fields):
    return o.http.patch(f"{API}/intimations/{iid}", headers=who.headers, json={"version": version, **fields})


# ---------- registro ----------
def test_registro_somente_metadados_sem_armazenar_nem_processar(env):
    o, oid, ana, *_ = env
    i = register(o, ana)
    assert i["file"] == {"name": "intimacao.pdf", "sizeBytes": 2048, "contentType": "application/pdf",
                         "storage": "not_stored"}
    assert i["processing"] == {"status": "not_available", "attempts": 0, "failureCode": None}
    assert i["status"] == "awaiting_review" and i["suggestion"] is None
    assert all(v is None for v in i["draft"].values())                     # nada "extraído"
    assert i["createdBy"] == ana.id and i["version"] == 1
    paths = o.http.get("/openapi.json").json()["paths"]
    assert not any("process" in p and "intimation" in p for p in paths)    # sem rota pública de processamento


@pytest.mark.parametrize("over", [
    {"fileName": "documento.docx"}, {"fileName": ""}, {"fileName": "a/b.pdf"}, {"fileName": "x" * 252 + ".pdf"},
    {"sizeBytes": 0}, {"sizeBytes": 10 * 1024 * 1024 + 1}, {"sizeBytes": "10"}, {"contentType": "text/plain"},
    {"receivedAt": "2026-02-30"}, {"scope": "global"}, {"status": "reviewed"}, {"storage": "s3"},
    {"deadlineId": "x"}, {"createdBy": "x"}, {"draft": {"title": "x"}}, {"processing": {"status": "completed"}},
    {"suggestion": {"source": "processing"}}, {"version": 3},
])
def test_registro_valida_e_rejeita_mass_assignment(env, over):
    o, oid, ana, *_ = env
    r = o.http.post(f"{API}/intimations", headers=ana.headers, json=reg_body(**over))
    assert r.status_code == 422, (over, r.text)
    assert o.app.state.org.unit_of_work.intimation_store.intimations == {}


def test_registro_exige_create_e_read_no_escritorio(env):
    o, oid, ana, bia, *_ = env
    o.set_perms(ana, oid, bia, ["deadline.read"])
    assert o.http.post(f"{API}/intimations", headers=bia.headers, json=reg_body()).status_code == 403
    o.set_perms(ana, oid, bia, ["deadline.create"])
    assert o.http.post(f"{API}/intimations", headers=bia.headers, json=reg_body()).status_code == 403


def test_sugestao_assigned_so_para_si_e_membro_ativo(env):
    o, oid, ana, bia, caio, zed = env
    r = o.http.post(f"{API}/intimations", headers=bia.headers, json=reg_body(suggestedResponsibleId=caio.id))
    assert r.status_code == 403 and r.json()["error"]["code"] == "delegation_not_allowed"
    assert register(o, bia, suggestedResponsibleId=bia.id)["suggestedResponsibleId"] == bia.id
    r = o.http.post(f"{API}/intimations", headers=ana.headers, json=reg_body(suggestedResponsibleId=zed.id))
    assert r.status_code == 422 and r.json()["error"]["code"] == "responsible_invalid"
    r = o.http.post(f"{API}/intimations", headers=ana.headers,
                    json=reg_body(scope="personal", suggestedResponsibleId=bia.id))
    assert r.status_code == 422


# ---------- leitura e isolamento ----------
def test_isolamento_pessoal_e_entre_escritorios(env):
    o, oid, ana, bia, caio, zed = env
    personal = register(o, bia, scope="personal")
    office = register(o, ana)
    for who, iid in ((ana, personal["id"]), (zed, office["id"]), (zed, personal["id"])):
        r = get_i(o, who, iid)
        assert r.status_code == 404 and r.json() == get_i(o, who, "inexistente").json()


def test_visibilidade_assigned_autor_e_sugerido(env):
    o, oid, ana, bia, caio, _ = env
    mine = register(o, bia)                                    # autora
    suggested = register(o, ana, suggestedResponsibleId=bia.id)
    other = register(o, ana, suggestedResponsibleId=caio.id)
    assert get_i(o, bia, mine["id"]).status_code == 200
    assert get_i(o, bia, suggested["id"]).status_code == 200
    assert get_i(o, bia, other["id"]).status_code == 404
    page = o.http.get(f"{API}/intimations?scope=office", headers=bia.headers).json()
    assert page["total"] == 2 and {i["id"] for i in page["items"]} == {mine["id"], suggested["id"]}
    assert o.http.get(f"{API}/intimations?scope=office", headers=ana.headers).json()["total"] == 3


def test_issue5_revisada_segue_responsavel_atual_do_prazo(env):
    o, oid, ana, bia, caio, _ = env
    i = register(o, ana, suggestedResponsibleId=bia.id)
    r = confirm(o, ana, i["id"], 1, responsibleId=bia.id)
    assert r.status_code == 201
    did = r.json()["deadline"]["id"]
    assert get_i(o, bia, i["id"]).json()["deadlineId"] == did              # responsável atual vê
    o.http.patch(f"{API}/deadlines/{did}", headers=ana.headers, json={"version": 1, "responsibleId": caio.id})
    assert get_i(o, bia, i["id"]).status_code == 404                       # sugestão antiga não basta
    assert get_i(o, caio, i["id"]).json()["deadlineId"] == did              # novo responsável vê


def test_intimacao_revisada_nao_revela_prazo_inacessivel(env):
    o, oid, ana, bia, caio, _ = env
    i = register(o, bia, suggestedResponsibleId=bia.id)                    # bia autora
    o.http.patch(f"{API}/offices/{oid}/members/{bia.id}", headers=ana.headers, json={"visibility": "assigned"})
    confirm(o, ana, i["id"], 1, responsibleId=caio.id)
    view = get_i(o, bia, i["id"]).json()                                   # autora ainda lê a intimação
    assert view["status"] == "reviewed" and view["linked"] is True and view["deadlineId"] is None


def test_perda_imediata_de_permissao(env):
    o, oid, ana, bia, *_ = env
    i = register(o, bia)
    o.set_perms(ana, oid, bia, ["deadline.create"])                        # mesmo token, sem read
    assert get_i(o, bia, i["id"]).status_code == 404
    assert o.http.get(f"{API}/intimations?scope=office", headers=bia.headers).status_code == 403


def test_listagem_filtra_antes_de_contar_e_oculta_descartadas(env):
    o, oid, ana, bia, caio, _ = env
    for _ in range(3):
        register(o, ana, suggestedResponsibleId=caio.id)
    keep = register(o, bia, fileName="peticao-inicial.pdf")
    gone = register(o, bia)
    o.http.post(f"{API}/intimations/{gone['id']}/discard", headers=bia.headers, json={"version": 1})
    page = o.http.get(f"{API}/intimations?scope=office", headers=bia.headers).json()
    assert page["total"] == 1 and page["items"][0]["id"] == keep["id"]
    disc = o.http.get(f"{API}/intimations?scope=office&status=discarded", headers=bia.headers).json()
    assert [i["id"] for i in disc["items"]] == [gone["id"]]
    assert o.http.get(f"{API}/intimations?scope=office&q=inicial", headers=bia.headers).json()["total"] == 1
    assert o.http.get(f"{API}/intimations?scope=office&perPage=101", headers=bia.headers).status_code == 422


# ---------- rascunho ----------
def test_rascunho_versao_estado_e_historico(env):
    o, oid, ana, bia, *_ = env
    i = register(o, bia)
    r = patch(o, bia, i["id"], 1, title="Contestação", dueDate="2026-11-20")
    assert r.status_code == 200 and r.json()["version"] == 2 and r.json()["draft"]["title"] == "Contestação"
    r = patch(o, bia, i["id"], 1, title="Stale")
    assert r.status_code == 409 and r.json()["error"]["code"] == "version_conflict"
    r = patch(o, bia, i["id"], 2, title="Contestação")                     # sem mudança efetiva
    assert r.json()["version"] == 2
    r = patch(o, bia, i["id"], 2, title=None)                              # null limpa
    assert r.json()["draft"]["title"] is None and r.json()["version"] == 3
    assert patch(o, bia, i["id"], 3, startDate="2026-12-01").status_code == 422   # vencimento < início
    events = o.http.get(f"{API}/intimations/{i['id']}/history", headers=bia.headers).json()["items"]
    assert [e["action"] for e in events] == ["registered", "draft_updated", "draft_updated"]


@pytest.mark.parametrize("fields", [{"status": "reviewed"}, {"deadlineId": "x"}, {"scope": "personal"},
                                    {"createdBy": "x"}, {"file": {}}, {"duration": 0}, {}])
def test_rascunho_rejeita_campos_protegidos(env, fields):
    o, oid, ana, bia, *_ = env
    i = register(o, bia)
    assert patch(o, bia, i["id"], 1, **fields).status_code == 422


def test_sugestao_no_rascunho_autorizacao_antes_da_versao(env):
    o, oid, ana, bia, caio, _ = env
    i = register(o, bia, suggestedResponsibleId=bia.id)
    r = patch(o, bia, i["id"], 99, suggestedResponsibleId=caio.id)          # assigned → outro, versão errada
    assert r.status_code == 403 and "x-current-version" not in r.headers
    r = patch(o, ana, i["id"], 1, suggestedResponsibleId=caio.id)
    assert r.status_code == 200 and r.json()["suggestedResponsibleId"] == caio.id
    assert get_i(o, caio, i["id"]).status_code == 200


# ---------- descarte e nova tentativa ----------
def test_descarte_regras(env):
    o, oid, ana, bia, caio, _ = env
    i = register(o, ana, suggestedResponsibleId=bia.id)
    r = o.http.post(f"{API}/intimations/{i['id']}/discard", headers=bia.headers, json={"version": 1})
    assert r.status_code == 403                                            # sugerida, mas não autora nem all
    r = o.http.post(f"{API}/intimations/{i['id']}/discard", headers=ana.headers, json={"version": 1})
    assert r.status_code == 200 and r.json()["status"] == "discarded" and r.json()["closedAt"]
    for path, body in ((f"/intimations/{i['id']}", {"version": 2, "title": "Título válido"}),
                       (f"/intimations/{i['id']}/confirm", None),
                       (f"/intimations/{i['id']}/retry", {"version": 2}),
                       (f"/intimations/{i['id']}/discard", {"version": 2})):
        if body is None:
            r = confirm(o, ana, i["id"], 2)
        else:
            method = o.http.patch if path.endswith(i["id"]) else o.http.post
            r = method(f"{API}{path}", headers=ana.headers, json=body)
        assert r.status_code == 409 and r.json()["error"]["code"] == "invalid_state", path
    assert get_i(o, bia, i["id"]).status_code == 404                       # sugestão não vale mais


def test_revisada_nao_pode_ser_descartada(env):
    o, oid, ana, *_ = env
    i = register(o, ana)
    confirm(o, ana, i["id"], 1)
    r = o.http.post(f"{API}/intimations/{i['id']}/discard", headers=ana.headers, json={"version": 2})
    assert r.status_code == 409 and r.json()["error"]["code"] == "invalid_state"


def test_retry_indisponivel(env):
    o, oid, ana, *_ = env
    i = register(o, ana)
    r = o.http.post(f"{API}/intimations/{i['id']}/retry", headers=ana.headers, json={"version": 1})
    assert r.status_code == 409 and r.json()["error"]["code"] == "invalid_state"
