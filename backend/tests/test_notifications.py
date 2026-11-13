"""Etapa 5 — notificações internas: destinatário, privacidade, leitura, caixa e retenção."""
import dataclasses

import pytest

from app.domain.intimations import Notification
from tests.deadline_utils import create
from tests.intimation_utils import confirm, notifications, register, unread
from tests.org_utils import API


@pytest.fixture
def env(org):
    o = org()
    ana, bia, caio = o.person("ana"), o.person("bia"), o.person("caio")
    oid = o.office(ana)
    o.join(ana, oid, bia)
    o.join(ana, oid, caio)
    return o, oid, ana, bia, caio


def nstore(o):
    return o.app.state.org.unit_of_work.notification_store


def test_notificacao_nao_guarda_conteudo():
    names = {f.name for f in dataclasses.fields(Notification)}
    assert names == {"id", "recipient_id", "scope", "kind", "resource_type", "resource_id", "event_id",
                     "created_at", "read_at"}


def test_somente_o_destinatario_e_sem_autonotificacao(env):
    o, oid, ana, bia, caio = env
    create(o, ana, responsibleId=bia.id)
    create(o, ana)                                                   # para si mesma: sem notificação
    assert notifications(o, bia).json()["total"] == 1
    assert notifications(o, ana).json()["total"] == 0
    assert notifications(o, caio).json()["total"] == 0
    item = notifications(o, bia).json()["items"][0]
    assert item["kind"] == "deadline_assigned" and item["summary"]["title"] == "Contestação"


def test_gatilhos_de_atribuicao(env):
    o, oid, ana, bia, caio = env
    d = create(o, ana, responsibleId=bia.id)
    o.http.patch(f"{API}/deadlines/{d['id']}", headers=ana.headers, json={"version": 1, "responsibleId": caio.id})
    register(o, ana, suggestedResponsibleId=caio.id)
    kinds = sorted(n["kind"] for n in notifications(o, caio).json()["items"])
    assert kinds == ["deadline_assigned", "intimation_assigned"]


def test_perda_de_acesso_oculta_lista_e_contagem_e_recuperacao_mostra(env):
    o, oid, ana, bia, caio = env
    d = create(o, ana, responsibleId=bia.id)
    assert unread(o, bia) == {"unread": 1}
    o.http.patch(f"{API}/deadlines/{d['id']}", headers=ana.headers, json={"version": 1, "responsibleId": caio.id})
    page = notifications(o, bia).json()
    assert page["total"] == 0 and page["unread"] == 0 and unread(o, bia) == {"unread": 0}
    assert "Contestação" not in str(page)
    nid = next(iter(nstore(o).by_recipient[bia.id]))
    r = o.http.post(f"{API}/notifications/{nid}/read", headers=bia.headers)
    assert r.status_code == 404                                      # oculta não pode ser marcada
    assert o.http.post(f"{API}/notifications/read-all?scope=office", headers=bia.headers).json() == {"marked": 0}
    o.http.patch(f"{API}/deadlines/{d['id']}", headers=ana.headers, json={"version": 2, "responsibleId": bia.id})
    assert unread(o, bia)["unread"] == 2                             # a antiga volta + a nova


def test_ex_membro_nao_ve_conteudo(env):
    o, oid, ana, bia, caio = env
    create(o, ana, responsibleId=bia.id, title="Segredo processual")
    o.http.post(f"{API}/offices/{oid}/members/{bia.id}/remove", headers=ana.headers, json={"reassignTo": caio.id})
    for scope in ("office", "personal"):
        page = notifications(o, bia, scope=scope).json()
        assert page["total"] == 0 and "Segredo" not in str(page)


def test_marcar_lida_individual_e_de_terceiros(env, clock):
    o, oid, ana, bia, caio = env
    create(o, ana, responsibleId=bia.id)
    clock.advance(1)
    create(o, ana, responsibleId=bia.id, title="Segundo prazo")
    items = notifications(o, bia).json()["items"]
    assert items[0]["summary"]["title"] == "Segundo prazo"           # instante desc
    nid = items[0]["id"]
    assert o.http.post(f"{API}/notifications/{nid}/read", headers=caio.headers).status_code == 404
    r = o.http.post(f"{API}/notifications/{nid}/read", headers=bia.headers)
    assert r.status_code == 200 and r.json()["readAt"]
    again = o.http.post(f"{API}/notifications/{nid}/read", headers=bia.headers)
    assert again.json()["readAt"] == r.json()["readAt"]               # idempotente
    assert unread(o, bia) == {"unread": 1}
    assert notifications(o, bia, unreadOnly="true").json()["total"] == 1
    assert o.http.post(f"{API}/notifications/read-all?scope=office", headers=bia.headers).json() == {"marked": 1}
    assert unread(o, bia) == {"unread": 0}


def test_escopo_pessoal_sem_notificacoes_nesta_etapa(env):
    o, oid, ana, bia, caio = env
    create(o, bia, scope="personal")
    assert notifications(o, bia, scope="personal").json()["total"] == 0
    assert "retenção" in notifications(o, bia).json()["retentionPolicy"]


def test_politica_da_caixa_remove_lidas_e_depois_nao_lidas(org, clock):
    o = org(NOTIFICATIONS_MAX_PER_RECIPIENT=10)
    ana, bia = o.person("ana"), o.person("bia")
    oid = o.office(ana)
    o.join(ana, oid, bia)
    made = []
    for i in range(10):
        clock.advance(1)
        made.append(create(o, ana, responsibleId=bia.id, title=f"Prazo {i:02d}"))
    o.relogin(bia)
    items = notifications(o, bia, perPage=100).json()["items"]
    by_title = {n["summary"]["title"]: n["id"] for n in items}
    for t in ("Prazo 05", "Prazo 06"):                               # duas lidas (não as mais antigas)
        o.http.post(f"{API}/notifications/{by_title[t]}/read", headers=bia.headers)
    clock.advance(1)
    o.relogin(ana)
    create(o, ana, responsibleId=bia.id, title="Prazo 10")          # 11ª → remove a lida mais antiga (05)
    titles = [n["summary"]["title"] for n in notifications(o, bia, perPage=100).json()["items"]]
    assert "Prazo 05" not in titles and "Prazo 06" in titles and "Prazo 00" in titles
    for k in range(11, 13):
        clock.advance(1)
        create(o, ana, responsibleId=bia.id, title=f"Prazo {k}")
    titles = [n["summary"]["title"] for n in notifications(o, bia, perPage=100).json()["items"]]
    assert "Prazo 06" not in titles and "Prazo 00" not in titles   # depois as não lidas mais antigas
    st = nstore(o)
    assert len(st.by_recipient[bia.id]) == 10 and len(st.dedupe) == 10 and len(st.notifications) == 10


@pytest.mark.memory_only(
    "retenção dentro das transações em memória; equivalente SQL (P5): "
    "test_maintenance_operation::test_sql_notificacoes_lidas_removidas_apos_retencao_sem_recriar"
)
def test_retencao_de_lidas_remove_indices_e_nao_recria(org, clock):
    o = org()
    ana, bia = o.person("ana"), o.person("bia")
    oid = o.office(ana)
    o.join(ana, oid, bia)
    i = register(o, ana)
    confirm(o, ana, i["id"], 1, responsibleId=bia.id)
    o.http.post(f"{API}/notifications/read-all?scope=office", headers=bia.headers)
    clock.advance(90 * 24 * 3600)
    o.relogin(ana)
    o.relogin(bia)
    assert notifications(o, bia).json()["total"] == 0                # removida pela retenção
    st = nstore(o)
    assert st.notifications == {} and st.by_recipient == {} and st.dedupe == {}
    r = confirm(o, ana, i["id"], 1, responsibleId=bia.id)            # repetição idempotente
    assert r.status_code == 200 and st.notifications == {}           # não recria


def test_endpoints_validam_parametros(env):
    o, oid, ana, bia, caio = env
    assert o.http.get(f"{API}/notifications", headers=bia.headers).status_code == 422
    assert o.http.get(f"{API}/notifications?scope=office&perPage=101", headers=bia.headers).status_code == 422
    assert o.http.get(f"{API}/notifications?scope=office").status_code == 401
