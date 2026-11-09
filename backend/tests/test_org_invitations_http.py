"""Etapa 3 — convites: criação, consulta pública, aceitação, revogação, limites."""
import logging

import pytest

from app.security.tokens import hash_opaque_token
from tests.org_utils import API, MEMBER

WEEK = 7 * 24 * 3600


def _lookup(o, token):
    return o.http.post(f"{API}/invitations/lookup", json={"token": token})


def _accept(o, person, token):
    return o.http.post(f"{API}/invitations/accept", headers=person.headers, json={"token": token})


def test_criacao_devolve_token_uma_vez_e_guarda_so_hash(org):
    o = org()
    ana = o.person("ana")
    oid = o.office(ana)
    r = o.http.post(f"{API}/offices/{oid}/invitations", headers=ana.headers, json={"roleLabel": "Advogado"})
    assert r.status_code == 201
    body = r.json()
    token = body["token"]
    assert len(token) >= 40 and body["state"] == "valid" and body["roleLabel"] == "Advogado"
    inv = o.store.invitations[body["id"]]
    assert inv.token_hash == hash_opaque_token(token) and token not in repr(vars(o.store))
    listing = o.http.get(f"{API}/offices/{oid}/invitations", headers=ana.headers)
    assert token not in listing.text and "token" not in listing.json()[0]
    assert (body["expiresAt"] > body["createdAt"])


def test_convite_nao_aceita_privilegios_no_payload(org):
    o = org()
    ana = o.person("ana")
    oid = o.office(ana)
    for extra in ({"permissions": ["office.manage"]}, {"visibility": "all"}, {"officeId": "outro"}, {"expiresAt": "x"}):
        r = o.http.post(f"{API}/offices/{oid}/invitations", headers=ana.headers, json={"roleLabel": "X", **extra})
        assert r.status_code == 422
    assert o.store.invitations == {}


def test_aceitacao_cria_vinculo_comum_e_ignora_payload_do_convidado(org):
    o = org()
    ana, bia = o.person("ana"), o.person("bia")
    oid = o.office(ana)
    token = o.invite(ana, oid, "Advogada")
    bad = o.http.post(f"{API}/invitations/accept", headers=bia.headers,
                      json={"token": token, "permissions": ["office.manage"]})
    assert bad.status_code == 422 and o.membership(bia) is None
    r = _accept(o, bia, token)
    assert r.status_code == 200
    m = r.json()["membership"]
    assert m["permissions"] == MEMBER and m["visibility"] == "assigned" and m["roleLabel"] == "Advogada"


def test_estados_da_consulta_publica(org, clock):
    o = org()
    ana, bia, caio = o.person("ana"), o.person("bia"), o.person("caio")
    oid = o.office(ana, "Silva & Lima")
    valid = o.invite(ana, oid)
    assert _lookup(o, valid).json() == {"state": "valid", "officeName": "Silva & Lima"}
    assert _lookup(o, "token-que-nao-existe-123456").json() == {"state": "invalid"}
    _accept(o, bia, valid)
    assert _lookup(o, valid).json() == {"state": "used"}
    revoked = o.invite(ana, oid)
    inv_id = next(i.id for i in o.store.invitations.values() if i.token_hash == hash_opaque_token(revoked))
    assert o.http.post(f"{API}/offices/{oid}/invitations/{inv_id}/revoke", headers=ana.headers).status_code == 200
    assert _lookup(o, revoked).json() == {"state": "revoked"}
    expiring = o.invite(ana, oid)
    clock.advance(WEEK)
    o.relogin(caio)
    assert _lookup(o, expiring).json() == {"state": "expired"}
    for token, code in ((valid, "invitation_used"), (revoked, "invitation_revoked"), (expiring, "invitation_expired")):
        r = _accept(o, caio, token)
        assert r.status_code == 410 and r.json()["error"]["code"] == code
    r = _accept(o, caio, "token-que-nao-existe-123456")
    assert r.status_code == 404 and r.json()["error"]["code"] == "invitation_invalid"
    assert o.membership(caio) is None


def test_consulta_publica_nao_expoe_dados_administrativos(org):
    o = org()
    ana = o.person("ana")
    oid = o.office(ana)
    token = o.invite(ana, oid)
    body = _lookup(o, token).json()
    assert set(body) == {"state", "officeName"}
    code = o.http.get(f"{API}/offices/{oid}/join-code", headers=ana.headers).json()["joinCode"]
    assert code not in repr(body) and "ana@" not in repr(body) and oid not in repr(body)


def test_aceitacao_exige_autenticacao_e_bloqueia_segundo_escritorio(org):
    o = org()
    ana, zed = o.person("ana"), o.person("zed")
    oid = o.office(ana)
    o.office(zed, "Do Zed")
    token = o.invite(ana, oid)
    assert o.http.post(f"{API}/invitations/accept", json={"token": token}).status_code == 401
    r = _accept(o, zed, token)
    assert r.status_code == 409 and r.json()["error"]["code"] == "already_in_office"
    assert _lookup(o, token).json()["state"] == "valid"        # convite não foi gasto


def test_revogacao_exige_gestao_e_estado_pendente(org):
    o = org()
    ana, bia = o.person("ana"), o.person("bia")
    oid = o.office(ana)
    o.join(ana, oid, bia)
    o.invite(ana, oid)
    inv_id = next(i.id for i in o.store.invitations.values() if i.status == "pending")
    assert o.http.post(f"{API}/offices/{oid}/invitations/{inv_id}/revoke", headers=bia.headers).status_code == 403
    assert o.http.post(f"{API}/offices/{oid}/invitations/{inv_id}/revoke", headers=ana.headers).status_code == 200
    r = o.http.post(f"{API}/offices/{oid}/invitations/{inv_id}/revoke", headers=ana.headers)
    assert r.status_code == 409 and r.json()["error"]["code"] == "invitation_not_pending"
    assert o.http.post(f"{API}/offices/{oid}/invitations", headers=bia.headers, json={}).status_code == 403


def test_token_nao_aparece_em_logs(org, caplog):
    o = org()
    caplog.set_level(logging.DEBUG)
    ana, bia = o.person("ana"), o.person("bia")
    oid = o.office(ana)
    token = o.invite(ana, oid)
    _lookup(o, token)
    _accept(o, bia, token)
    code = o.http.get(f"{API}/offices/{oid}/join-code", headers=ana.headers).json()["joinCode"]
    assert token not in caplog.text and code not in caplog.text
    assert "bia@exemplo.com" not in caplog.text


def test_limites_de_criacao_consulta_e_aceitacao(org, clock):
    o = org(ORG_INVITE_CREATE_MAX=2, ORG_INVITE_LOOKUP_MAX=3, ORG_INVITE_ACCEPT_MAX=2)
    ana, bia = o.person("ana"), o.person("bia")
    oid = o.office(ana)
    o.invite(ana, oid)
    o.invite(ana, oid)
    r = o.http.post(f"{API}/offices/{oid}/invitations", headers=ana.headers, json={})
    assert r.status_code == 429 and r.headers["retry-after"] == "3600"
    for _ in range(3):
        assert _lookup(o, "x" * 30).status_code == 200
    assert _lookup(o, "x" * 30).status_code == 429
    for _ in range(2):
        assert _accept(o, bia, "y" * 30).status_code == 404
    assert _accept(o, bia, "y" * 30).status_code == 429
    clock.advance(3600)
    o.relogin(ana)
    assert o.http.post(f"{API}/offices/{oid}/invitations", headers=ana.headers, json={}).status_code == 201


def test_teto_de_convites_pendentes(org):
    o = org(ORG_MAX_PENDING_INVITES_PER_OFFICE=2)
    ana = o.person("ana")
    oid = o.office(ana)
    o.invite(ana, oid)
    o.invite(ana, oid)
    r = o.http.post(f"{API}/offices/{oid}/invitations", headers=ana.headers, json={})
    assert r.status_code == 409 and r.json()["error"]["code"] == "pending_limit_reached"


@pytest.mark.parametrize("token", ["", "curto", "x" * 300])
def test_formato_de_token_invalido(org, token):
    o = org()
    assert _lookup(o, token).status_code == 422
