"""Etapa 3 — escritórios: criação, consulta, edição, isolamento e privacidade (HTTP)."""
import pytest
from fastapi.testclient import TestClient

from app.services.org_container import InMemoryOrgBlockedError
from tests.org_utils import ALL, API


def test_criar_escritorio_cria_vinculo_administrativo(org):
    o = org()
    ana = o.person("ana")
    r = o.http.post(f"{API}/offices", headers=ana.headers,
                    json={"name": "  Silva   Advogados ", "roleLabel": "Sócia", "practiceAreas": ["Cível", "Família"]})
    assert r.status_code == 201
    body = r.json()
    assert body["office"]["name"] == "Silva Advogados"
    assert set(body["office"]) == {"id", "name", "createdAt"}   # sem código, sem createdBy
    m = body["membership"]
    assert m["permissions"] == ALL and m["visibility"] == "all"
    assert m["roleLabel"] == "Sócia" and m["practiceAreas"] == ["Cível", "Família"]
    me = o.http.get(f"{API}/memberships/me", headers=ana.headers).json()
    assert me["office"]["id"] == body["office"]["id"] and me["membership"]["officeId"] == body["office"]["id"]


def test_sem_vinculo_memberships_me_retorna_nulos(org):
    o = org()
    bia = o.person("bia")
    assert o.http.get(f"{API}/memberships/me", headers=bia.headers).json() == {"office": None, "membership": None}


def test_segundo_escritorio_e_bloqueado(org):
    o = org()
    ana = o.person("ana")
    o.office(ana)
    r = o.http.post(f"{API}/offices", headers=ana.headers, json={"name": "Outro"})
    assert r.status_code == 409 and r.json()["error"]["code"] == "already_in_office"
    assert len(o.store.offices) == 1


@pytest.mark.parametrize("payload", [
    {"name": "A"}, {"name": ""}, {"name": "x" * 121}, {"name": "Ok\x07"},
    {"name": "Escritório", "ownerId": "outro"}, {"name": "Escritório", "permissions": ["office.manage"]},
    {"name": "Escritório", "id": "fixo"}, {"name": "Escritório", "joinCode": "ABCDEFGHJK"},
    {"name": "Escritório", "practiceAreas": ["Cível", "cível"]},
    {"name": "Escritório", "practiceAreas": [""]}, {"name": "Escritório", "roleLabel": ""},
    {"name": "Escritório", "practiceAreas": ["a"] * 21},
])
def test_criacao_rejeita_dados_invalidos_e_campos_privilegiados(org, payload):
    o = org()
    ana = o.person("ana")
    assert o.http.post(f"{API}/offices", headers=ana.headers, json=payload).status_code == 422
    assert o.store.offices == {} and o.store.membership_by_user == {}


def test_criacao_exige_autenticacao(org):
    o = org()
    assert o.http.post(f"{API}/offices", json={"name": "Escritório"}).status_code == 401


def test_editar_escritorio_exige_office_manage(org):
    o = org()
    ana, bia = o.person("ana"), o.person("bia")
    oid = o.office(ana)
    o.join(ana, oid, bia)
    assert o.http.patch(f"{API}/offices/{oid}", headers=bia.headers, json={"name": "Novo"}).status_code == 403
    r = o.http.patch(f"{API}/offices/{oid}", headers=ana.headers, json={"name": "Novo Nome"})
    assert r.status_code == 200 and r.json()["name"] == "Novo Nome"
    assert o.http.patch(f"{API}/offices/{oid}", headers=ana.headers, json={"name": "X", "id": "y"}).status_code == 422


def test_externo_recebe_404_em_tudo_do_outro_escritorio(org):
    o = org()
    ana, bia, zed = o.person("ana"), o.person("bia"), o.person("zed")
    oid = o.office(ana)
    o.join(ana, oid, bia)
    o.office(zed, "Escritório do Zed")
    o.http.post(f"{API}/offices/{oid}/invitations", headers=ana.headers, json={})
    inv_id = next(iter(o.store.invitations))
    bia_id = bia.id
    calls = [
        ("get", f"/offices/{oid}", None), ("patch", f"/offices/{oid}", {"name": "Hack"}),
        ("get", f"/offices/{oid}/members", None),
        ("patch", f"/offices/{oid}/members/{bia_id}", {"roleLabel": "X"}),
        ("post", f"/offices/{oid}/members/{bia_id}/promote", None),
        ("post", f"/offices/{oid}/members/{bia_id}/remove", {}),
        ("post", f"/offices/{oid}/leave", {}),
        ("get", f"/offices/{oid}/join-code", None), ("post", f"/offices/{oid}/join-code/rotate", None),
        ("get", f"/offices/{oid}/invitations", None), ("post", f"/offices/{oid}/invitations", {}),
        ("post", f"/offices/{oid}/invitations/{inv_id}/revoke", None),
        ("get", f"/offices/{oid}/join-requests", None),
        ("post", f"/offices/{oid}/join-requests/qualquer/approve", None),
        ("post", f"/offices/{oid}/join-requests/qualquer/reject", None),
    ]
    snapshot = repr(sorted(o.store.membership_by_user.items())), repr(sorted(o.store.invitations.items()))
    for method, path, body in calls:
        kwargs = {"headers": zed.headers}
        if body is not None:
            kwargs["json"] = body
        r = getattr(o.http, method)(f"{API}{path}", **kwargs)
        assert r.status_code == 404, (path, r.status_code)
        assert r.json()["error"]["code"] == "not_found"
    # Inexistente e inacessível respondem igual.
    assert o.http.get(f"{API}/offices/nao-existe", headers=zed.headers).json() == \
        o.http.get(f"{API}/offices/{oid}", headers=zed.headers).json()
    assert snapshot == (repr(sorted(o.store.membership_by_user.items())), repr(sorted(o.store.invitations.items())))


def test_entrar_em_escritorio_nao_altera_dados_pessoais(org):
    o = org()
    ana, bia = o.person("ana"), o.person("bia")
    before = o.http.get(f"{API}/users/me", headers=bia.headers).json()
    oid = o.office(ana)
    o.join(ana, oid, bia)
    assert o.http.get(f"{API}/users/me", headers=bia.headers).json() == before
    members = o.http.get(f"{API}/offices/{oid}/members", headers=ana.headers).json()["members"]
    text = repr(members)
    for forbidden in ("password", "argon2", "session", "preferences", "token"):
        assert forbidden not in text.lower()


def test_production_bloqueia_escritorios_mesmo_com_auth_desligada(make_app):
    with pytest.raises(InMemoryOrgBlockedError):
        make_app(ENVIRONMENT="production", AUTH_ENABLED="false", OFFICES_ENABLED="true")


def test_production_com_auth_desligada_e_escritorios_padrao_sobe_sem_rotas(make_app):
    client = TestClient(make_app(ENVIRONMENT="production", AUTH_ENABLED="false"), raise_server_exceptions=False)
    assert client.post(f"{API}/offices", json={}).status_code == 404


def test_escritorios_exigem_autenticacao_ligada(make_app):
    with pytest.raises(ValueError):
        make_app(AUTH_ENABLED="false", OFFICES_ENABLED="true")


def test_escritorios_desligados_removem_rotas(make_app):
    client = TestClient(make_app(OFFICES_ENABLED="false"), raise_server_exceptions=False)
    assert client.post(f"{API}/invitations/lookup", json={"token": "x" * 20}).status_code == 404
    assert client.get(f"{API}/memberships/me").status_code == 404


@pytest.mark.parametrize("path", ["/api/offices", "/api/invitations/lookup", "/api/join-requests",
                                  "/api/memberships/me"])
def test_alias_legado_nao_expoe_rotas_de_escritorio(org, path):
    o = org()
    assert o.http.post(path, json={}).status_code == 404
    assert o.http.get(path).status_code in (404, 405)


def test_offices_enabled_vazio_acompanha_auth(make_app):
    app = make_app(OFFICES_ENABLED="")
    assert app.state.org is not None


def test_env_example_carrega_sem_erros(monkeypatch):
    """O .env.example (só placeholders) precisa ser uma configuração válida de desenvolvimento."""
    import pathlib

    from app.core.config import Settings

    example = pathlib.Path(__file__).resolve().parents[1] / ".env.example"
    for line in example.read_text(encoding="utf-8").splitlines():
        if line and not line.startswith("#") and "=" in line:
            key, value = line.split("=", 1)
            monkeypatch.setenv(key, value)
    settings = Settings(_env_file=None)
    assert settings.offices_active is True and settings.auth_jwt_secret is None
