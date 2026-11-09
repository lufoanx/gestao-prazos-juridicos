"""Etapa 3 — código de ingresso e solicitações (HTTP)."""
import pytest

from app.domain.org import JOIN_CODE_ALPHABET, JOIN_CODE_LENGTH
from tests.org_utils import API, MEMBER


def _code(o, admin, oid):
    return o.http.get(f"{API}/offices/{oid}/join-code", headers=admin.headers).json()["joinCode"]


def _request(o, person, code):
    return o.http.post(f"{API}/join-requests", headers=person.headers, json={"joinCode": code})


def test_codigo_e_aleatorio_separado_do_id_e_so_para_gestao(org):
    o = org()
    ana, bia = o.person("ana"), o.person("bia")
    oid = o.office(ana)
    o.join(ana, oid, bia)
    code = _code(o, ana, oid)
    assert len(code) == JOIN_CODE_LENGTH and all(c in JOIN_CODE_ALPHABET for c in code)
    assert code not in oid and code.lower() not in oid
    assert o.http.get(f"{API}/offices/{oid}/join-code", headers=bia.headers).status_code == 403


def test_girar_codigo_invalida_o_anterior(org):
    o = org()
    ana, bia = o.person("ana"), o.person("bia")
    oid = o.office(ana)
    old = _code(o, ana, oid)
    new = o.http.post(f"{API}/offices/{oid}/join-code/rotate", headers=ana.headers).json()["joinCode"]
    assert new != old
    assert _request(o, bia, old).json()["error"]["code"] == "join_code_invalid"
    assert _request(o, bia, new).status_code == 201


def test_solicitacao_nao_concede_vinculo_e_aceita_formatos(org):
    o = org()
    ana, bia = o.person("ana"), o.person("bia")
    oid = o.office(ana, "Lima Advocacia")
    code = _code(o, ana, oid)
    r = _request(o, bia, f" {code[:5].lower()}-{code[5:]} ")
    assert r.status_code == 201
    assert r.json()["status"] == "pending" and r.json()["officeName"] == "Lima Advocacia"
    assert o.membership(bia) is None
    assert o.http.get(f"{API}/memberships/me", headers=bia.headers).json()["membership"] is None


@pytest.mark.parametrize("code", ["", "ABC", "ILOU123456", "ABCDEFGHJKZ", "abcdefghj!"])
def test_codigo_em_formato_invalido(org, code):
    o = org()
    bia = o.person("bia")
    assert _request(o, bia, code).status_code == 422


def test_codigo_inexistente_e_id_interno_nao_funcionam(org):
    o = org()
    ana, bia = o.person("ana"), o.person("bia")
    oid = o.office(ana)
    r = _request(o, bia, "0000000000")
    assert r.status_code == 404 and r.json()["error"]["code"] == "join_code_invalid"
    assert _request(o, bia, oid).status_code == 422        # o ID interno não é código


def test_duplicidade_cancelamento_e_listagem_propria(org):
    o = org()
    ana, bia = o.person("ana"), o.person("bia")
    oid = o.office(ana)
    code = _code(o, ana, oid)
    rid = _request(o, bia, code).json()["id"]
    dup = _request(o, bia, code)
    assert dup.status_code == 409 and dup.json()["error"]["code"] == "request_already_pending"
    mine = o.http.get(f"{API}/join-requests/me", headers=bia.headers).json()
    assert [r["id"] for r in mine] == [rid]
    assert set(mine[0]) == {"id", "officeName", "status", "createdAt", "decidedAt"}
    r = o.http.post(f"{API}/join-requests/{rid}/cancel", headers=bia.headers)
    assert r.status_code == 200 and r.json()["status"] == "cancelled"
    assert o.http.post(f"{API}/join-requests/{rid}/cancel", headers=bia.headers).status_code == 409
    assert o.http.post(f"{API}/join-requests/{rid}/cancel", headers=ana.headers).status_code == 404  # não é dele
    assert _request(o, bia, code).status_code == 201       # nova pendência após cancelar


def test_gestao_lista_aprova_e_rejeita(org):
    o = org()
    ana, bia, caio, dani = o.person("ana"), o.person("bia"), o.person("caio"), o.person("dani")
    oid = o.office(ana)
    o.join(ana, oid, dani)
    code = _code(o, ana, oid)
    rb = _request(o, bia, code).json()["id"]
    rc = _request(o, caio, code).json()["id"]
    assert o.http.get(f"{API}/offices/{oid}/join-requests", headers=dani.headers).status_code == 403
    listing = o.http.get(f"{API}/offices/{oid}/join-requests?status=pending", headers=ana.headers).json()
    assert {r["requester"]["email"] for r in listing} == {"bia@exemplo.com", "caio@exemplo.com"}
    assert o.http.post(f"{API}/offices/{oid}/join-requests/{rb}/approve", headers=dani.headers).status_code == 403
    r = o.http.post(f"{API}/offices/{oid}/join-requests/{rb}/approve", headers=ana.headers)
    assert r.status_code == 200 and r.json()["status"] == "approved"
    assert o.membership(bia).permissions == frozenset(MEMBER) and o.membership(bia).visibility == "assigned"
    r = o.http.post(f"{API}/offices/{oid}/join-requests/{rc}/reject", headers=ana.headers)
    assert r.status_code == 200 and r.json()["status"] == "rejected"
    assert o.membership(caio) is None
    again = o.http.post(f"{API}/offices/{oid}/join-requests/{rc}/approve", headers=ana.headers)
    assert again.status_code == 409 and again.json()["error"]["code"] == "request_not_pending"
    assert o.http.get(f"{API}/offices/{oid}/join-requests?status=bogus", headers=ana.headers).status_code == 422


def test_conflito_na_aprovacao_resulta_em_cancelled_e_409(org):
    o = org()
    ana, zed, bia = o.person("ana"), o.person("zed"), o.person("bia")
    oid = o.office(ana)
    zid = o.office(zed, "Do Zed")
    rid = _request(o, bia, _code(o, ana, oid)).json()["id"]
    # bia entra no escritório do zed por convite: a pendência em ana vira cancelled.
    o.join(zed, zid, bia)
    req = o.store.requests[rid]
    assert req.status == "cancelled" and req.decided_by is None
    r = o.http.post(f"{API}/offices/{oid}/join-requests/{rid}/approve", headers=ana.headers)
    assert r.status_code == 409 and r.json()["error"]["code"] == "request_not_pending"


def test_aprovacao_encontra_conflito_e_cancela(org):
    """Conflito detectado NA aprovação (pendência ainda aberta): 409 + cancelled, nunca rejected."""
    o = org()
    ana, zed, bia = o.person("ana"), o.person("zed"), o.person("bia")
    oid = o.office(ana)
    zid = o.office(zed, "Do Zed")
    rid = _request(o, bia, _code(o, ana, oid)).json()["id"]
    from app.domain.org import MEMBER_PERMISSIONS, Membership
    with o.store.lock:   # vínculo criado por outro caminho, sem passar pelo cancelamento automático
        m = Membership(bia.id, zid, "Membro", (), MEMBER_PERMISSIONS, "assigned", o.store.offices[zid].created_at)
        o.store.membership_by_user[bia.id] = m
        o.store.members_by_office[zid] = o.store.members_by_office[zid] | {bia.id}
    assert o.store.requests[rid].status == "pending"
    r = o.http.post(f"{API}/offices/{oid}/join-requests/{rid}/approve", headers=ana.headers)
    assert r.status_code == 409 and r.json()["error"]["code"] == "already_in_office"
    assert o.store.requests[rid].status == "cancelled"
    assert o.membership(bia).office_id == zid


def test_entrar_por_qualquer_caminho_cancela_outras_pendencias(org):
    o = org()
    a1, a2, a3, bia, caio = (o.person(n) for n in ("a1", "a2", "a3", "bia", "caio"))
    o1, o2, o3 = o.office(a1, "Um"), o.office(a2, "Dois"), o.office(a3, "Tres")
    codes = [_code(o, a, i) for a, i in ((a1, o1), (a2, o2), (a3, o3))]
    rb = [_request(o, bia, c).json()["id"] for c in codes]
    rc = [_request(o, caio, c).json()["id"] for c in codes[:2]]
    # bia: aprovação em o1 cancela as de o2 e o3
    o.http.post(f"{API}/offices/{o1}/join-requests/{rb[0]}/approve", headers=a1.headers)
    assert [o.store.requests[r].status for r in rb] == ["approved", "cancelled", "cancelled"]
    # caio: criar escritório cancela as pendências
    o.office(caio, "Do Caio")
    assert [o.store.requests[r].status for r in rc] == ["cancelled", "cancelled"]


def test_quem_ja_tem_escritorio_nao_solicita(org):
    o = org()
    ana, zed = o.person("ana"), o.person("zed")
    oid = o.office(ana)
    o.office(zed, "Do Zed")
    r = _request(o, zed, _code(o, ana, oid))
    assert r.status_code == 409 and r.json()["error"]["code"] == "already_in_office"


def test_limites_de_solicitacao(org):
    o = org(ORG_JOIN_REQUEST_MAX=3, ORG_MAX_PENDING_REQUESTS_PER_USER=2)
    admins = [o.person(f"adm{i}") for i in range(3)]
    codes = [_code(o, a, o.office(a, f"Esc {i}")) for i, a in enumerate(admins)]
    bia = o.person("bia")
    assert _request(o, bia, codes[0]).status_code == 201
    assert _request(o, bia, codes[1]).status_code == 201
    r = _request(o, bia, codes[2])
    assert r.status_code == 409 and r.json()["error"]["code"] == "pending_limit_reached"
    r = _request(o, bia, "0000000000")          # 4ª tentativa na janela (inclui as inválidas)
    assert r.status_code == 429


def test_limite_por_escritorio(org):
    o = org(ORG_MAX_PENDING_REQUESTS_PER_OFFICE=1)
    ana, bia, caio = o.person("ana"), o.person("bia"), o.person("caio")
    code = _code(o, ana, o.office(ana))
    assert _request(o, bia, code).status_code == 201
    assert _request(o, caio, code).json()["error"]["code"] == "pending_limit_reached"
