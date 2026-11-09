"""Etapa 3 — equipe: projeções, matriz de permissões, efeito imediato, remoção/saída."""
import pytest

from tests.org_utils import ALL, API, MEMBER

MANAGER = MEMBER + ["team.manage"]


@pytest.fixture
def team(org):
    """ana = admin; gil = gestor (team.manage, assigned); bia e caio = membros comuns."""
    o = org()
    ana, gil, bia, caio = o.person("ana"), o.person("gil"), o.person("bia"), o.person("caio")
    oid = o.office(ana)
    for p in (gil, bia, caio):
        o.join(ana, oid, p)
    assert o.set_perms(ana, oid, gil, MANAGER).status_code == 200
    return o, oid, ana, gil, bia, caio


def _members(o, oid, who):
    return o.http.get(f"{API}/offices/{oid}/members", headers=who.headers)


def test_projecoes_publica_e_administrativa(team):
    o, oid, ana, gil, bia, _ = team
    pub = _members(o, oid, bia).json()
    assert pub["projection"] == "public"
    assert all(set(m) == {"userId", "name", "roleLabel", "practiceAreas"} for m in pub["members"])
    adm = _members(o, oid, gil).json()
    assert adm["projection"] == "admin"
    assert all({"email", "permissions", "visibility", "joinedAt"} <= set(m) for m in adm["members"])
    assert len(adm["members"]) == 4


def test_gestor_edita_cargo_areas_e_permissoes_de_membro_comum(team):
    o, oid, ana, gil, bia, _ = team
    body = {"roleLabel": "Estagiária", "practiceAreas": ["Trabalhista"], "permissions": ["deadline.read"]}
    r = o.http.patch(f"{API}/offices/{oid}/members/{bia.id}", headers=gil.headers, json=body)
    assert r.status_code == 200
    assert r.json()["roleLabel"] == "Estagiária" and r.json()["permissions"] == ["deadline.read"]


@pytest.mark.parametrize("payload", [
    {}, {"permissions": []}, {"permissions": ["deadline.read", "deadline.read"]},
    {"permissions": ["deadline.hack"]}, {"visibility": "everyone"}, {"email": "x@y.com"},
    {"userId": "outro"}, {"officeId": "outro"}, {"roleLabel": "  "}, {"practiceAreas": ["A", "a"]},
])
def test_edicao_rejeita_payload_invalido_sem_alterar_nada(team, payload):
    o, oid, ana, gil, bia, _ = team
    before = o.membership(bia)
    r = o.http.patch(f"{API}/offices/{oid}/members/{bia.id}", headers=ana.headers, json=payload)
    assert r.status_code == 422
    assert o.membership(bia) == before


def test_office_manage_exige_team_manage(team):
    o, oid, ana, gil, bia, _ = team
    r = o.set_perms(ana, oid, bia, ["deadline.read", "office.manage"])
    assert r.status_code == 422 and r.json()["error"]["code"] == "invalid_permission_set"


def test_gestor_nao_concede_privilegios_administrativos_nem_o_que_nao_tem(team):
    o, oid, ana, gil, bia, _ = team
    for perms in (MEMBER + ["team.manage"], ALL, MEMBER + ["deadline.transfer"]):
        r = o.set_perms(gil, oid, bia, perms)
        assert r.status_code == 403 and r.json()["error"]["code"] == "delegation_not_allowed"
    assert o.membership(bia).permissions == frozenset(MEMBER)


def test_gestor_assigned_nao_concede_visibilidade_all(team):
    o, oid, ana, gil, bia, _ = team
    r = o.http.patch(f"{API}/offices/{oid}/members/{bia.id}", headers=gil.headers, json={"visibility": "all"})
    assert r.status_code == 403 and r.json()["error"]["code"] == "delegation_not_allowed"
    o.http.patch(f"{API}/offices/{oid}/members/{gil.id}", headers=ana.headers, json={"visibility": "all"})
    assert o.http.patch(f"{API}/offices/{oid}/members/{bia.id}", headers=gil.headers,
                        json={"visibility": "all"}).status_code == 200


def test_gestor_nao_altera_admin_nem_outro_gestor(team):
    o, oid, ana, gil, bia, caio = team
    o.set_perms(ana, oid, caio, MANAGER)
    assert o.http.patch(f"{API}/offices/{oid}/members/{caio.id}", headers=gil.headers,
                        json={"roleLabel": "Rebaixado"}).status_code == 403
    assert o.set_perms(gil, oid, ana, MEMBER).status_code == 403
    assert o.membership(ana).permissions == frozenset(ALL)


def test_autoescalada_bloqueada(team):
    o, oid, ana, gil, bia, _ = team
    r = o.set_perms(gil, oid, gil, MANAGER + ["deadline.transfer"])
    assert r.status_code == 403 and r.json()["error"]["code"] == "self_escalation_forbidden"
    r = o.http.patch(f"{API}/offices/{oid}/members/{gil.id}", headers=gil.headers, json={"visibility": "all"})
    assert r.status_code == 403 and r.json()["error"]["code"] == "self_escalation_forbidden"
    assert o.set_perms(bia, oid, bia, MEMBER + ["deadline.transfer"]).status_code == 403


def test_escalada_indireta_entre_dois_gestores(team):
    """gil e caio (gestores) tentam ampliar um ao outro: bloqueado."""
    o, oid, ana, gil, bia, caio = team
    o.set_perms(ana, oid, caio, MANAGER)
    assert o.set_perms(gil, oid, caio, MANAGER + ["deadline.transfer"]).status_code == 403
    assert o.set_perms(caio, oid, gil, ALL).status_code == 403
    assert o.http.patch(f"{API}/offices/{oid}/members/{gil.id}", headers=caio.headers,
                        json={"visibility": "all"}).status_code == 403
    assert o.membership(gil).permissions == frozenset(MANAGER)


def test_reducao_de_permissoes_vale_na_proxima_requisicao(team):
    o, oid, ana, gil, bia, _ = team
    assert o.http.get(f"{API}/offices/{oid}/invitations", headers=gil.headers).status_code == 200
    assert o.set_perms(ana, oid, gil, MEMBER).status_code == 200     # mesmo access token de gil
    assert o.http.get(f"{API}/offices/{oid}/invitations", headers=gil.headers).status_code == 403
    assert _members(o, oid, gil).json()["projection"] == "public"


def test_ultimo_administrador_preservado_e_promocao(team):
    o, oid, ana, gil, bia, _ = team
    r = o.set_perms(ana, oid, ana, MANAGER)
    assert r.status_code == 409 and r.json()["error"]["code"] == "last_admin"
    assert o.http.post(f"{API}/offices/{oid}/members/{gil.id}/promote", headers=gil.headers).status_code == 403
    r = o.http.post(f"{API}/offices/{oid}/members/{gil.id}/promote", headers=ana.headers)
    assert r.status_code == 200 and "office.manage" in r.json()["permissions"]
    assert o.set_perms(ana, oid, ana, MANAGER).status_code == 200     # agora há outro admin
    r = o.set_perms(gil, oid, gil, MANAGER)
    assert r.status_code == 409 and r.json()["error"]["code"] == "last_admin"


def test_promover_a_si_mesmo_ou_externo(team, org):
    o, oid, ana, gil, bia, _ = team
    r = o.http.post(f"{API}/offices/{oid}/members/{ana.id}/promote", headers=ana.headers)
    assert r.status_code == 409 and r.json()["error"]["code"] == "invalid_successor"
    assert o.http.post(f"{API}/offices/{oid}/members/nao-membro/promote", headers=ana.headers).status_code == 404


def test_remocao_e_saida_bloqueadas_sem_modulo_de_prazos(team):
    o, oid, ana, gil, bia, _ = team
    snapshot = dict(o.store.membership_by_user)
    for who, path, body in [
        (ana, f"/offices/{oid}/members/{bia.id}/remove", {"reassignTo": gil.id}),
        (gil, f"/offices/{oid}/members/{bia.id}/remove", {}),
        (bia, f"/offices/{oid}/leave", {}),
        (ana, f"/offices/{oid}/leave", {"successorUserId": gil.id}),
    ]:
        r = o.http.post(f"{API}{path}", headers=who.headers, json=body)
        assert r.status_code == 409 and r.json()["error"]["code"] == "responsibility_module_unavailable"
    assert dict(o.store.membership_by_user) == snapshot        # nenhum efeito, nenhum sucessor promovido
    assert "office.manage" not in o.membership(gil).permissions


def test_validacoes_de_remocao_e_saida_precedem_o_bloqueio(team):
    o, oid, ana, gil, bia, _ = team
    assert o.http.post(f"{API}/offices/{oid}/members/{ana.id}/remove", headers=gil.headers,
                       json={}).json()["error"]["code"] == "forbidden"
    assert o.http.post(f"{API}/offices/{oid}/members/{bia.id}/remove", headers=bia.headers,
                       json={}).json()["error"]["code"] == "forbidden"
    assert o.http.post(f"{API}/offices/{oid}/members/{ana.id}/remove", headers=ana.headers,
                       json={}).json()["error"]["code"] == "cannot_remove_self"
    r = o.http.post(f"{API}/offices/{oid}/leave", headers=ana.headers, json={})
    assert r.json()["error"]["code"] == "successor_required"
    r = o.http.post(f"{API}/offices/{oid}/leave", headers=ana.headers, json={"successorUserId": ana.id})
    assert r.json()["error"]["code"] == "successor_required"
