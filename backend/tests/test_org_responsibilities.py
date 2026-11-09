"""Etapa 3 — políticas de remoção/saída com ADAPTADORES CONTROLADOS de responsabilidades.

ATENÇÃO: estes testes NÃO são integração com o módulo de prazos (Etapa 4). Eles usam
adaptadores falsos para verificar as regras do lado do escritório: ordem das
verificações, sucessor, reatribuição obrigatória e ausência de efeitos parciais.
Em execução real, o adaptador padrão bloqueia (409 responsibility_module_unavailable).
"""
import pytest

from tests.org_utils import API


class ControlledPort:
    def __init__(self, open_by_user=None, fail_on_reassign=False):
        self.open = dict(open_by_user or {})
        self.fail = fail_on_reassign
        self.calls = []

    def count_open(self, office_id, user_id):
        self.calls.append(("count", user_id))
        return self.open.get(user_id, 0)

    def reassign_open(self, office_id, from_user_id, to_user_id):
        self.calls.append(("reassign", from_user_id, to_user_id))
        if self.fail:
            raise RuntimeError("falha simulada na reatribuição")
        moved, self.open[from_user_id] = self.open.get(from_user_id, 0), 0
        self.open[to_user_id] = self.open.get(to_user_id, 0) + moved
        return moved


@pytest.fixture
def setup(org):
    def _setup(port):
        o = org(responsibility_port=port)
        ana, bia, caio = o.person("ana"), o.person("bia"), o.person("caio")
        oid = o.office(ana)
        o.join(ana, oid, bia)
        o.join(ana, oid, caio)
        return o, oid, ana, bia, caio
    return _setup


def _remove(o, actor, oid, target, reassign=None):
    body = {"reassignTo": reassign.id} if reassign else {}
    return o.http.post(f"{API}/offices/{oid}/members/{target.id}/remove", headers=actor.headers, json=body)


def _leave(o, actor, oid, successor=None, reassign=None):
    body = {}
    if successor:
        body["successorUserId"] = successor.id
    if reassign:
        body["reassignTo"] = reassign.id
    return o.http.post(f"{API}/offices/{oid}/leave", headers=actor.headers, json=body)


def test_remocao_sem_responsabilidades_preserva_dados_pessoais(setup):
    o, oid, ana, bia, caio = setup(ControlledPort())
    profile = o.http.get(f"{API}/users/me", headers=bia.headers).json()
    assert _remove(o, ana, oid, bia).status_code == 204
    assert o.membership(bia) is None
    assert o.http.get(f"{API}/users/me", headers=bia.headers).json() == profile     # conta intacta
    assert o.http.get(f"{API}/offices/{oid}", headers=bia.headers).status_code == 404   # perde acesso já


def test_remocao_com_responsabilidades_exige_reatribuicao_valida(setup):
    port = ControlledPort()
    o, oid, ana, bia, caio = setup(port)
    port.open = {bia.id: 3}
    for reassign in (None, bia):
        r = _remove(o, ana, oid, bia, reassign)
        assert r.status_code == 409 and r.json()["error"]["code"] == "reassign_required"
    r = o.http.post(f"{API}/offices/{oid}/members/{bia.id}/remove", headers=ana.headers,
                    json={"reassignTo": "nao-membro"})
    assert r.json()["error"]["code"] == "reassign_required"
    assert o.membership(bia) is not None and port.open[bia.id] == 3
    assert _remove(o, ana, oid, bia, caio).status_code == 204
    assert port.open == {bia.id: 0, caio.id: 3} and o.membership(bia) is None


def test_falha_na_reatribuicao_nao_produz_efeito_parcial(setup):
    port = ControlledPort()
    o, oid, ana, bia, caio = setup(port)
    port.open, port.fail = {bia.id: 2}, True
    r = _remove(o, ana, oid, bia, caio)
    assert r.status_code == 500 and r.json() == {"error": {"code": "internal_error", "message": "Erro interno."}}
    assert o.membership(bia) is not None


def test_saida_do_ultimo_admin_promove_sucessor_atomicamente(setup):
    o, oid, ana, bia, caio = setup(ControlledPort())
    assert _leave(o, ana, oid).json()["error"]["code"] == "successor_required"
    assert _leave(o, ana, oid, successor=bia).status_code == 204
    assert o.membership(ana) is None
    assert o.membership(bia).is_admin and o.membership(bia).is_manager


def test_falha_na_saida_nao_promove_sucessor(setup):
    port = ControlledPort()
    o, oid, ana, bia, caio = setup(port)
    port.open, port.fail = {ana.id: 1}, True
    r = _leave(o, ana, oid, successor=bia, reassign=caio)
    assert r.status_code == 500
    assert o.membership(ana).is_admin and not o.membership(bia).is_admin


def test_saida_de_membro_comum_com_reatribuicao(setup):
    port = ControlledPort()
    o, oid, ana, bia, caio = setup(port)
    port.open = {bia.id: 1}
    assert _leave(o, bia, oid).json()["error"]["code"] == "reassign_required"
    assert _leave(o, bia, oid, reassign=caio).status_code == 204
    assert o.membership(bia) is None and port.open[caio.id] == 1


def test_verificacoes_de_autorizacao_ocorrem_antes_da_porta(setup):
    port = ControlledPort()
    o, oid, ana, bia, caio = setup(port)
    assert _remove(o, bia, oid, caio).status_code == 403
    assert _remove(o, ana, oid, ana).status_code == 409
    assert port.calls == []                     # porta nunca consultada sem autorização
