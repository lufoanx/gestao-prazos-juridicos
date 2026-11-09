"""Etapa 4 — status, reabertura com responsável inativo, versões e transferência."""
import pytest

from tests.deadline_utils import TRANSFER, create, get, listing, set_status
from tests.org_utils import API


@pytest.fixture
def env(org):
    o = org()
    ana, bia, caio = o.person("ana"), o.person("bia"), o.person("caio")
    oid = o.office(ana)
    o.join(ana, oid, bia)
    o.join(ana, oid, caio)
    return o, oid, ana, bia, caio


def history(o, who, did):
    return o.http.get(f"{API}/deadlines/{did}/history", headers=who.headers).json()["items"]


def test_transicoes_aprovadas(env):
    o, oid, ana, bia, _ = env
    d = create(o, ana)
    assert set_status(o, ana, d["id"], 1, "completed").json()["status"] == "completed"
    assert set_status(o, ana, d["id"], 2, "open").json()["status"] == "open"
    assert set_status(o, ana, d["id"], 3, "cancelled").json()["status"] == "cancelled"
    assert set_status(o, ana, d["id"], 4, "open").json()["version"] == 5
    acts = [(e["action"], e["details"]) for e in history(o, ana, d["id"])][1:]
    assert acts == [("status_changed", {"from": "open", "to": "completed"}),
                    ("status_changed", {"from": "completed", "to": "open"}),
                    ("status_changed", {"from": "open", "to": "cancelled"}),
                    ("status_changed", {"from": "cancelled", "to": "open"})]


def test_concluido_cancelado_direto_e_status_repetido(env):
    o, oid, ana, *_ = env
    d = create(o, ana)
    set_status(o, ana, d["id"], 1, "completed")
    r = set_status(o, ana, d["id"], 2, "cancelled")
    assert r.status_code == 409 and r.json()["error"]["code"] == "invalid_transition"
    r = set_status(o, ana, d["id"], 2, "completed")
    assert r.status_code == 409 and r.json()["error"]["code"] == "status_unchanged"
    assert get(o, ana, d["id"]).json()["version"] == 2 and len(history(o, ana, d["id"])) == 2


def test_status_exige_complete_e_versao(env):
    o, oid, ana, bia, _ = env
    d = create(o, ana, responsibleId=bia.id)
    o.set_perms(ana, oid, bia, ["deadline.read", "deadline.edit"])
    assert set_status(o, bia, d["id"], 1, "completed").status_code == 403
    r = set_status(o, ana, d["id"], 7, "completed")
    assert r.status_code == 409 and r.json()["error"]["code"] == "version_conflict"
    r = o.http.post(f"{API}/deadlines/{d['id']}/status", headers=ana.headers, json={"status": "completed"})
    assert r.status_code == 422
    r = set_status(o, ana, d["id"], 1, "completed", responsibleId=bia.id)   # só na reabertura
    assert r.status_code == 422


def test_reabertura_com_responsavel_inativo(env):
    o, oid, ana, bia, caio = env
    d = create(o, ana, responsibleId=bia.id)
    set_status(o, ana, d["id"], 1, "completed")
    assert o.http.post(f"{API}/offices/{oid}/members/{bia.id}/remove", headers=ana.headers,
                       json={}).status_code == 204            # concluído não exige reatribuição
    assert get(o, ana, d["id"]).json()["responsibleId"] == bia.id          # concluído não é alterado
    r = set_status(o, ana, d["id"], 2, "open")
    assert r.status_code == 409 and r.json()["error"]["code"] == "responsible_inactive"
    r = set_status(o, ana, d["id"], 2, "open", responsibleId="nao-membro")
    assert r.status_code == 422 and r.json()["error"]["code"] == "responsible_invalid"
    r = set_status(o, ana, d["id"], 2, "open", responsibleId=caio.id)
    assert r.status_code == 200 and r.json()["responsibleId"] == caio.id and r.json()["version"] == 3
    last = history(o, ana, d["id"])[-2:]
    assert [e["action"] for e in last] == ["status_changed", "reassigned"]
    assert last[1]["details"] == {"fromResponsibleId": bia.id, "toResponsibleId": caio.id, "reason": "reopen"}


def test_reabertura_com_reatribuicao_exige_edit(env):
    o, oid, ana, bia, caio = env
    d = create(o, ana, responsibleId=bia.id)
    set_status(o, ana, d["id"], 1, "completed")
    o.set_perms(ana, oid, caio, ["deadline.read", "deadline.complete"])
    o.http.patch(f"{API}/offices/{oid}/members/{caio.id}", headers=ana.headers, json={"visibility": "all"})
    r = set_status(o, caio, d["id"], 2, "open", responsibleId=caio.id)
    assert r.status_code == 403
    assert set_status(o, caio, d["id"], 2, "open").status_code == 200    # sem reatribuição: só complete


# ---------- transferência ----------
def test_transferencia_preserva_id_comentarios_historico_e_autoria(env):
    o, oid, ana, bia, caio = env
    o.set_perms(ana, oid, bia, TRANSFER)
    p = create(o, bia, scope="personal")
    o.http.post(f"{API}/deadlines/{p['id']}/comments", headers=bia.headers, json={"text": "Nota pessoal"})
    r = o.http.post(f"{API}/deadlines/{p['id']}/transfer", headers=bia.headers,
                    json={"version": 1, "officeId": oid, "confirmSharing": True})
    assert r.status_code == 200
    moved = r.json()["deadline"]
    assert "compartilhad" in r.json()["notice"].lower() or "visíveis" in r.json()["notice"]
    assert moved["id"] == p["id"] and moved["scope"] == {"kind": "office", "ownerId": None, "officeId": oid}
    assert moved["responsibleId"] == bia.id and moved["createdBy"] == bia.id and moved["version"] == 2
    store = o.app.state.org.deadline_store
    assert len(store.deadlines) == 1                                     # sem duplicação
    assert listing(o, bia, scope="personal").json()["total"] == 0
    assert listing(o, ana).json()["total"] == 1
    assert len(store.comments[p["id"]]) == 1
    assert o.http.get(f"{API}/deadlines/{p['id']}/comments", headers=ana.headers).json()["total"] == 1
    ev = history(o, ana, p["id"])
    assert [e["action"] for e in ev] == ["created", "transferred"]
    assert ev[-1]["details"] == {"fromScope": "personal", "toOfficeId": oid}


@pytest.mark.parametrize("payload,expected", [
    ({"version": 1, "confirmSharing": False}, 422), ({"version": 1}, 422),
    ({"version": 1, "confirmSharing": True, "extra": 1}, 422),
])
def test_transferencia_exige_confirmacao(env, payload, expected):
    o, oid, ana, bia, _ = env
    o.set_perms(ana, oid, bia, TRANSFER)
    p = create(o, bia, scope="personal")
    r = o.http.post(f"{API}/deadlines/{p['id']}/transfer", headers=bia.headers, json={"officeId": oid, **payload})
    assert r.status_code == expected
    assert get(o, bia, p["id"]).json()["scope"]["kind"] == "personal"


def test_transferencia_regras(env, org):
    o, oid, ana, bia, caio = env
    p = create(o, bia, scope="personal")
    tr = lambda who, did, office, v=1: o.http.post(  # noqa: E731
        f"{API}/deadlines/{did}/transfer", headers=who.headers,
        json={"version": v, "officeId": office, "confirmSharing": True})
    assert tr(bia, p["id"], oid).status_code == 403                      # sem deadline.transfer
    o.set_perms(ana, oid, bia, TRANSFER)
    assert tr(ana, p["id"], oid).status_code == 404                      # pessoal alheio
    assert tr(bia, p["id"], "outro-escritorio").status_code == 404       # destino ≠ vínculo atual
    r = tr(bia, p["id"], oid, v=9)
    assert r.status_code == 409 and r.json()["error"]["code"] == "version_conflict"
    assert tr(bia, p["id"], oid).status_code == 200
    r = tr(bia, p["id"], oid, v=2)                                       # já é do escritório
    assert r.status_code == 409 and r.json()["error"]["code"] == "not_transferable"
    done = create(o, bia, scope="personal")
    o.http.post(f"{API}/deadlines/{done['id']}/status", headers=bia.headers, json={"version": 1, "status": "completed"})
    assert tr(bia, done["id"], oid, v=2).status_code == 200              # qualquer status


def test_transferencia_sem_escritorio(org):
    o = org()
    zed = o.person("zed")
    p = create(o, zed, scope="personal")
    r = o.http.post(f"{API}/deadlines/{p['id']}/transfer", headers=zed.headers,
                    json={"version": 1, "officeId": "qualquer", "confirmSharing": True})
    assert r.status_code == 404
