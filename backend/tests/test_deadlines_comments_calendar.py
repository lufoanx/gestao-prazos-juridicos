"""Etapa 4 — comentários, histórico e calendário."""
import pytest

from tests.deadline_utils import READ_ONLY, body, create
from tests.org_utils import API


@pytest.fixture
def env(org):
    o = org()
    ana, bia, caio = o.person("ana"), o.person("bia"), o.person("caio")
    oid = o.office(ana)
    o.join(ana, oid, bia)
    o.join(ana, oid, caio)
    return o, oid, ana, bia, caio


def comment(o, who, did, text="Ok"):
    return o.http.post(f"{API}/deadlines/{did}/comments", headers=who.headers, json={"text": text})


# ---------- comentários ----------
def test_comentario_autoria_e_horario_do_servidor(env, clock):
    o, oid, ana, bia, _ = env
    d = create(o, ana, responsibleId=bia.id)
    r = comment(o, bia, d["id"], "  Petição protocolada.\nAguardando.  ")
    assert r.status_code == 201
    c = r.json()
    assert c["authorId"] == bia.id and c["createdAt"] == clock.now().isoformat().replace("+00:00", "Z")
    bad = o.http.post(f"{API}/deadlines/{d['id']}/comments", headers=bia.headers,
                      json={"text": "x", "authorId": ana.id})
    assert bad.status_code == 422
    for text in ("", "   ", "x" * 2001, "a\x00b"):
        assert comment(o, bia, d["id"], text).status_code == 422


def test_comentario_subordinado_ao_prazo(env):
    o, oid, ana, bia, caio = env
    d = create(o, ana, responsibleId=caio.id)
    assert comment(o, bia, d["id"]).status_code == 404                  # bia não lê o prazo
    assert o.http.get(f"{API}/deadlines/{d['id']}/comments", headers=bia.headers).status_code == 404
    o.set_perms(ana, oid, caio, READ_ONLY)
    assert comment(o, caio, d["id"]).status_code == 403                 # lê, mas sem deadline.create
    assert o.http.get(f"{API}/deadlines/{d['id']}/comments", headers=caio.headers).status_code == 200
    personal = create(o, bia, scope="personal")
    assert comment(o, ana, personal["id"]).status_code == 404


def test_comentarios_paginados_e_limite(org):
    o = org(DEADLINES_MAX_COMMENTS=3)
    ana = o.person("ana")
    o.office(ana)
    d = create(o, ana)
    for i in range(3):
        assert comment(o, ana, d["id"], f"c{i}").status_code == 201
    r = comment(o, ana, d["id"], "excedente")
    assert r.status_code == 409 and r.json()["error"]["code"] == "comment_limit_reached"
    page = o.http.get(f"{API}/deadlines/{d['id']}/comments?perPage=2&page=2", headers=ana.headers).json()
    assert page["total"] == 3 and [c["text"] for c in page["items"]] == ["c2"]


def test_historico_somente_leitura_e_sem_dados_sensiveis(env):
    o, oid, ana, *_ = env
    d = create(o, ana)
    h = o.http.get(f"{API}/deadlines/{d['id']}/history", headers=ana.headers)
    assert h.status_code == 200 and h.json()["items"][0]["action"] == "created"
    assert set(h.json()["items"][0]) == {"id", "actorId", "action", "at", "details"}
    for method in ("post", "patch", "delete", "put"):
        assert getattr(o.http, method)(f"{API}/deadlines/{d['id']}/history", headers=ana.headers).status_code == 405
    text = h.text.lower()
    assert "password" not in text and "token" not in text and "@" not in text


def test_limite_de_historico_recusa_sem_truncar(org):
    o = org(DEADLINES_MAX_HISTORY=10)
    ana = o.person("ana")
    o.office(ana)
    d = create(o, ana)
    v = 1
    for i in range(9):
        r = o.http.patch(f"{API}/deadlines/{d['id']}", headers=ana.headers, json={"version": v, "title": f"Título {i}"})
        assert r.status_code == 200
        v += 1
    r = o.http.patch(f"{API}/deadlines/{d['id']}", headers=ana.headers, json={"version": v, "title": "Excedente"})
    assert r.status_code == 409 and r.json()["error"]["code"] == "history_limit_reached"
    got = o.http.get(f"{API}/deadlines/{d['id']}", headers=ana.headers).json()
    assert got["title"] == "Título 8" and got["version"] == v           # nada aplicado
    assert len(o.app.state.org.deadline_store.history[d["id"]]) == 10


def test_limite_de_prazos_por_escopo(org):
    o = org(DEADLINES_MAX_PER_SCOPE=2)
    ana = o.person("ana")
    create(o, ana, scope="personal")
    create(o, ana, scope="personal")
    r = o.http.post(f"{API}/deadlines", headers=ana.headers, json=body(scope="personal"))
    assert r.status_code == 409 and r.json()["error"]["code"] == "deadline_limit_reached"


# ---------- calendário ----------
def cal(o, who, **params):
    params.setdefault("scope", "office")
    return o.http.get(f"{API}/calendar", headers=who.headers, params=params)


def test_calendario_intervalo_civil_e_limites(env):
    o, oid, ana, bia, caio = env
    for due in ("2026-10-31", "2026-11-01", "2026-11-30", "2026-12-01"):
        create(o, ana, startDate="2026-10-01", dueDate=due)
    r = cal(o, ana, year=2026, month=11).json()
    assert [d["dueDate"] for d in r["items"]] == ["2026-11-01", "2026-11-30"]
    assert r["countsByDay"] == {"2026-11-01": 1, "2026-11-30": 1} and r["total"] == 2
    assert r["timezone"] == "America/Sao_Paulo" and r["hasNextPage"] is False and r["nextPage"] is None
    for bad in ({"year": 1999, "month": 1}, {"year": 2026, "month": 13}, {"year": 2026, "month": 0}, {"year": 2026}):
        assert cal(o, ana, **bad).status_code == 422
    create(o, ana, startDate="2028-02-01", dueDate="2028-02-29")        # ano bissexto
    assert cal(o, ana, year=2028, month=2).json()["total"] == 1


def test_calendario_aplica_autorizacao_antes_de_contar_e_paginar(env):
    o, oid, ana, bia, caio = env
    create(o, ana, responsibleId=bia.id, dueDate="2026-11-20")
    for _ in range(3):
        create(o, ana, responsibleId=caio.id, dueDate="2026-11-20")
    r = cal(o, bia, year=2026, month=11).json()
    assert r["total"] == 1 and r["countsByDay"] == {"2026-11-20": 1}
    personal = create(o, bia, scope="personal", dueDate="2026-11-21")
    assert [d["id"] for d in cal(o, bia, scope="personal", year=2026, month=11).json()["items"]] == [personal["id"]]
    assert cal(o, ana, scope="personal", year=2026, month=11).json()["total"] == 0


def test_calendario_pagina_todos_os_itens_com_ordem_estavel(env):
    o, oid, ana, *_ = env
    made = []
    for i in range(7):
        made.append(create(o, ana, dueDate="2026-11-20" if i % 2 else "2026-11-10",
                           agendaTime=None if i == 3 else f"{8 + i:02d}:00"))
    seen = []
    page = 1
    while True:
        r = cal(o, ana, year=2026, month=11, perPage=3, page=page).json()
        seen += r["items"]
        assert r["total"] == 7 and r["pageCount"] == 3
        if not r["hasNextPage"]:
            break
        assert r["nextPage"] == page + 1
        page += 1
    assert len(seen) == 7 and len({d["id"] for d in seen}) == 7
    keys = [(d["dueDate"], d["agendaTime"] or "99", d["id"]) for d in seen]
    assert keys == sorted(keys)
    assert cal(o, ana, year=2026, month=11, perPage=501).status_code == 422
    assert cal(o, ana, year=2026, month=11, perPage=500).json()["hasNextPage"] is False


def test_calendario_filtra_status(env):
    o, oid, ana, *_ = env
    d = create(o, ana)
    create(o, ana)
    o.http.post(f"{API}/deadlines/{d['id']}/status", headers=ana.headers, json={"version": 1, "status": "cancelled"})
    assert cal(o, ana, year=2026, month=11, status="open").json()["total"] == 1
    assert cal(o, ana, year=2026, month=11).json()["total"] == 2
