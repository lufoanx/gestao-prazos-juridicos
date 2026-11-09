"""Etapa 4 — prazos: criação, consulta, edição, validação, isolamento, visibilidade e listagens."""
import pytest

from tests.deadline_utils import EDITOR, READ_ONLY, body, create, get, listing, patch
from tests.org_utils import API, MEMBER


@pytest.fixture
def env(org):
    """ana: admin (all). bia, caio: membros (assigned). dani: externo com outro escritório."""
    o = org()
    ana, bia, caio, dani = o.person("ana"), o.person("bia"), o.person("caio"), o.person("dani")
    oid = o.office(ana)
    o.join(ana, oid, bia)
    o.join(ana, oid, caio)
    o.office(dani, "Outro")
    return o, oid, ana, bia, caio, dani


# ---------- criação ----------
def test_criacao_pessoal_define_dono_e_campos_do_servidor(env):
    o, oid, ana, bia, *_ = env
    d = create(o, bia, scope="personal", agendaTime="09:30", priority="high", reviewed=False)
    assert d["scope"] == {"kind": "personal", "ownerId": bia.id, "officeId": None}
    assert d["responsibleId"] == bia.id and d["createdBy"] == bia.id
    assert d["status"] == "open" and d["version"] == 1 and d["agendaTime"] == "09:30"
    assert d["reviewed"] is False and d["priority"] == "high"
    assert d["startDate"] == "2026-11-09" and d["dueDate"] == "2026-11-20"      # datas civis sem conversão


def test_criacao_pessoal_nao_aceita_outro_responsavel(env):
    o, oid, ana, bia, *_ = env
    r = o.http.post(f"{API}/deadlines", headers=bia.headers, json=body(scope="personal", responsibleId=ana.id))
    assert r.status_code == 422 and r.json()["error"]["code"] == "responsible_invalid"


def test_assigned_so_cria_para_si(env):
    o, oid, ana, bia, caio, _ = env
    r = o.http.post(f"{API}/deadlines", headers=bia.headers, json=body(responsibleId=caio.id))
    assert r.status_code == 403 and r.json()["error"]["code"] == "delegation_not_allowed"
    assert o.app.state.org.deadline_store.deadlines == {}
    assert create(o, bia)["responsibleId"] == bia.id


def test_all_atribui_a_membro_ativo_do_mesmo_escritorio(env):
    o, oid, ana, bia, caio, dani = env
    assert create(o, ana, responsibleId=caio.id)["responsibleId"] == caio.id
    for invalid in (dani.id, "nao-existe"):
        r = o.http.post(f"{API}/deadlines", headers=ana.headers, json=body(responsibleId=invalid))
        assert r.status_code == 422 and r.json()["error"]["code"] == "responsible_invalid"


def test_criacao_no_escritorio_exige_create_e_read(env):
    o, oid, ana, bia, *_ = env
    o.set_perms(ana, oid, bia, ["deadline.create", "deadline.complete"])
    assert o.http.post(f"{API}/deadlines", headers=bia.headers, json=body()).status_code == 403
    o.set_perms(ana, oid, bia, READ_ONLY)
    assert o.http.post(f"{API}/deadlines", headers=bia.headers, json=body()).status_code == 403


def test_criacao_no_escritorio_sem_vinculo(org):
    o = org()
    zed = o.person("zed")
    r = o.http.post(f"{API}/deadlines", headers=zed.headers, json=body())
    assert r.status_code == 404


@pytest.mark.parametrize("over", [
    {"title": "ab"}, {"title": "x" * 201}, {"caseNumber": "12"}, {"caseNumber": "x" * 51}, {"court": "T"},
    {"practiceArea": ""}, {"practiceArea": "x" * 61}, {"startDate": "2026-02-30"}, {"dueDate": "2026/11/20"},
    {"dueDate": "1999-12-31"}, {"dueDate": "2101-01-01"}, {"dueDate": "2026-11-08"},    # antes do início
    {"agendaTime": "24:00"}, {"agendaTime": "9:30"}, {"duration": 0}, {"duration": 3651}, {"duration": 1.5},
    {"duration": "5"}, {"priority": "urgent"}, {"countingMode": "corridos"}, {"scope": "global"},
    {"reviewed": "sim"}, {"status": "completed"}, {"id": "fixo"}, {"ownerId": "x"}, {"officeId": "x"},
    {"createdBy": "x"}, {"version": 5}, {"createdAt": "2026-01-01T00:00:00Z"},
])
def test_validacao_e_mass_assignment_na_criacao(env, over):
    o, oid, ana, *_ = env
    r = o.http.post(f"{API}/deadlines", headers=ana.headers, json=body(**over))
    assert r.status_code == 422, (over, r.text)
    assert o.app.state.org.deadline_store.deadlines == {}


# ---------- consulta e isolamento ----------
def test_isolamento_pessoal_e_entre_escritorios(env):
    o, oid, ana, bia, caio, dani = env
    personal = create(o, bia, scope="personal")
    office = create(o, ana)
    for who, did in ((ana, personal["id"]), (caio, personal["id"]), (dani, personal["id"]), (dani, office["id"])):
        r = get(o, who, did)
        assert r.status_code == 404 and r.json() == get(o, who, "inexistente").json()
    assert get(o, bia, personal["id"]).status_code == 200


def test_visibilidade_assigned_e_all(env):
    o, oid, ana, bia, caio, _ = env
    mine = create(o, ana, responsibleId=bia.id)
    other = create(o, ana, responsibleId=caio.id)
    assert get(o, bia, mine["id"]).status_code == 200
    assert get(o, bia, other["id"]).status_code == 404
    assert get(o, ana, other["id"]).status_code == 200
    ids = [d["id"] for d in listing(o, bia).json()["items"]]
    assert ids == [mine["id"]] and listing(o, bia).json()["total"] == 1
    assert listing(o, ana).json()["total"] == 2


def test_permissoes_atuais_valem_com_token_antigo(env):
    o, oid, ana, bia, *_ = env
    d = create(o, ana, responsibleId=bia.id)
    assert patch(o, bia, d["id"], 1, title="Novo título").status_code == 200
    o.set_perms(ana, oid, bia, READ_ONLY)                             # mesmo access token de bia
    assert patch(o, bia, d["id"], 2, title="Outro título").status_code == 403
    o.set_perms(ana, oid, bia, ["deadline.create"])                   # sem read: deixa de ver
    assert get(o, bia, d["id"]).status_code == 404
    assert listing(o, bia).status_code == 403


def test_gestao_sem_read_nao_ve_prazos(env):
    o, oid, ana, bia, *_ = env
    d = create(o, ana)
    o.set_perms(ana, oid, bia, ["team.manage"])
    assert get(o, bia, d["id"]).status_code == 404


# ---------- edição ----------
def test_patch_altera_campos_e_registra_historico(env):
    o, oid, ana, bia, *_ = env
    d = create(o, ana)
    r = patch(o, ana, d["id"], 1, title="Recurso", dueDate="2026-12-01", agendaTime="10:00", reviewed=False)
    assert r.status_code == 200 and r.json()["version"] == 2
    events = o.http.get(f"{API}/deadlines/{d['id']}/history", headers=ana.headers).json()["items"]
    assert events[-1]["action"] == "updated"
    assert events[-1]["details"]["changes"]["dueDate"] == {"from": "2026-11-20", "to": "2026-12-01"}
    r = patch(o, ana, d["id"], 2, agendaTime=None)                    # null remove o horário
    assert r.json()["agendaTime"] is None and r.json()["version"] == 3


def test_patch_sem_mudanca_efetiva_nao_gera_versao_nem_historico(env):
    o, oid, ana, *_ = env
    d = create(o, ana)
    r = patch(o, ana, d["id"], 1, title=d["title"], duration=d["duration"])
    assert r.status_code == 200 and r.json()["version"] == 1
    assert o.http.get(f"{API}/deadlines/{d['id']}/history", headers=ana.headers).json()["total"] == 1


@pytest.mark.parametrize("fields", [
    {"status": "completed"}, {"scope": "personal"}, {"id": "x"}, {"ownerId": "x"}, {"officeId": "x"},
    {"createdBy": "x"}, {"createdAt": "2026-01-01T00:00:00Z"}, {"history": []}, {"title": None},
    {"dueDate": "2026-11-01"},
])
def test_patch_rejeita_campos_protegidos(env, fields):
    o, oid, ana, *_ = env
    d = create(o, ana)
    r = patch(o, ana, d["id"], 1, **fields)
    assert r.status_code == 422, (fields, r.text)
    assert get(o, ana, d["id"]).json()["version"] == 1


def test_patch_exige_versao_e_detecta_conflito(env):
    o, oid, ana, *_ = env
    d = create(o, ana)
    no_version = o.http.patch(f"{API}/deadlines/{d['id']}", headers=ana.headers, json={"title": "Sem versão"})
    assert no_version.status_code == 422
    assert patch(o, ana, d["id"], 1, title="Primeira").status_code == 200
    r = patch(o, ana, d["id"], 1, title="Segunda (stale)")
    assert r.status_code == 409 and r.json()["error"]["code"] == "version_conflict"
    assert r.headers["x-current-version"] == "2"
    assert get(o, ana, d["id"]).json()["title"] == "Primeira"


def test_conflito_de_versao_nao_e_revelado_sem_autorizacao(env):
    o, oid, ana, bia, caio, _ = env
    d = create(o, ana, responsibleId=caio.id)
    r = patch(o, bia, d["id"], 99, title="Tentativa")
    assert r.status_code == 404 and "version" not in r.text.lower()
    o.set_perms(ana, oid, bia, ["deadline.read"])
    o.http.patch(f"{API}/offices/{oid}/members/{bia.id}", headers=ana.headers, json={"visibility": "all"})
    r = patch(o, bia, d["id"], 99, title="Tentativa")
    assert r.status_code == 403 and "x-current-version" not in r.headers


def test_reatribuicao_por_patch(env):
    o, oid, ana, bia, caio, dani = env
    d = create(o, ana, responsibleId=bia.id)
    r = patch(o, bia, d["id"], 1, responsibleId=caio.id)              # assigned → outra pessoa
    assert r.status_code == 403 and r.json()["error"]["code"] == "delegation_not_allowed"
    r = patch(o, ana, d["id"], 1, responsibleId=dani.id)              # fora do escritório
    assert r.status_code == 422 and r.json()["error"]["code"] == "responsible_invalid"
    r = patch(o, ana, d["id"], 1, responsibleId=caio.id)
    assert r.status_code == 200 and r.json()["responsibleId"] == caio.id
    ev = o.http.get(f"{API}/deadlines/{d['id']}/history", headers=ana.headers).json()["items"][-1]
    assert ev["action"] == "reassigned"
    assert ev["details"] == {"fromResponsibleId": bia.id, "toResponsibleId": caio.id, "reason": "edit"}
    assert get(o, bia, d["id"]).status_code == 404                    # bia (assigned) perde acesso


def test_pessoal_patch_nao_troca_responsavel(env):
    o, oid, ana, bia, *_ = env
    d = create(o, bia, scope="personal")
    r = patch(o, bia, d["id"], 1, responsibleId=ana.id)
    assert r.status_code == 422 and r.json()["error"]["code"] == "responsible_invalid"


# ---------- listagens ----------
def test_paginacao_ordenacao_estavel_e_totais_autorizados(env):
    o, oid, ana, bia, caio, _ = env
    created = [create(o, ana, responsibleId=bia.id, dueDate="2026-11-20", title=f"Prazo {i:02d}") for i in range(7)]
    for i in range(5):
        create(o, ana, responsibleId=caio.id, title=f"Invisível {i}")
    ids_sorted = sorted(d["id"] for d in created)
    page1 = listing(o, bia, perPage=3, page=1).json()
    page3 = listing(o, bia, perPage=3, page=3).json()
    assert page1["total"] == 7 and page1["pageCount"] == 3
    got = page1["items"] + listing(o, bia, perPage=3, page=2).json()["items"] + page3["items"]
    assert [d["id"] for d in got] == ids_sorted              # mesmo vencimento: desempate por id
    assert listing(o, bia, perPage=3, page=9).json()["items"] == []
    assert listing(o, bia, q="Invisível").json()["total"] == 0          # busca não vaza
    assert listing(o, bia, perPage=101).status_code == 422


def test_filtros(env, clock):
    o, oid, ana, bia, *_ = env
    a = create(o, ana, title="Réplica trabalhista", practiceArea="Trabalhista", dueDate="2026-11-09")
    b = create(o, ana, title="Apelação", dueDate="2026-11-11", responsibleId=bia.id)
    c = create(o, ana, title="Memorial", dueDate="2026-12-30")
    o.http.post(f"{API}/deadlines/{c['id']}/status", headers=ana.headers, json={"version": 1, "status": "completed"})
    ids = lambda **p: [d["id"] for d in listing(o, ana, **p).json()["items"]]  # noqa: E731
    assert ids(q="réplica") == [a["id"]]
    assert ids(area="trabalhista") == [a["id"]]
    assert ids(status="completed") == [c["id"]]
    assert ids(urgency="today") == [a["id"]] and ids(urgency="soon") == [b["id"]]
    assert ids(responsibleId=bia.id) == [b["id"]]
    assert ids(dueFrom="2026-11-10", dueTo="2026-11-30") == [b["id"]]
    assert ids(sort="title") == [b["id"], c["id"], a["id"]]
    assert ids(sort="dueDate", dir="desc")[0] == c["id"]
    assert listing(o, ana, dueFrom="2026-13-01").status_code == 422
    assert listing(o, ana, scope="global").status_code == 422


def test_listagem_pessoal_e_de_escritorio_sao_separadas(env):
    o, oid, ana, bia, *_ = env
    create(o, bia, scope="personal")
    create(o, ana, responsibleId=bia.id)
    assert listing(o, bia, scope="personal").json()["total"] == 1
    assert listing(o, bia, scope="office").json()["total"] == 1
    assert listing(o, ana, scope="personal").json()["total"] == 0


def test_urgencia_usa_fuso_de_referencia(org, clock):
    """02:00 UTC de 10/11 ainda é 09/11 (23:00) em São Paulo (UTC-3): o prazo "vence hoje"."""
    o = org()
    ana = o.person("ana")
    o.office(ana)
    d = create(o, ana, dueDate="2026-11-09")
    clock.advance(14 * 3600)                                      # 2026-11-10 02:00 UTC
    o.relogin(ana)
    r = get(o, ana, d["id"]).json()
    assert r["urgency"] == {"level": "today", "days": 0}
    assert listing(o, ana).json()["referenceDate"] == "2026-11-09"


def test_timezone_invalido_e_rejeitado(make_app):
    with pytest.raises(Exception):
        make_app(DEADLINES_TIMEZONE="Marte/Olimpo")


def test_membro_sem_vinculo_member_perms(env):
    o, oid, ana, bia, *_ = env
    assert o.membership(bia).permissions == frozenset(MEMBER) and EDITOR == MEMBER
