"""Auxiliares dos testes da Etapa 4 (prazos). Sem segredos reais."""
from __future__ import annotations

from tests.org_utils import API, MEMBER

READ_ONLY = ["deadline.read"]
EDITOR = MEMBER                                          # read, create, edit, complete
TRANSFER = MEMBER + ["deadline.transfer"]


def body(**over):
    data = {
        "scope": "office", "title": "Contestação", "caseNumber": "0001234-56.2026", "court": "TJSC 2ª Vara",
        "practiceArea": "Cível", "startDate": "2026-11-09", "dueDate": "2026-11-20", "countingMode": "business",
        "duration": 10,
    }
    data.update(over)
    return {k: v for k, v in data.items() if v is not None}


def create(o, person, **over):
    r = o.http.post(f"{API}/deadlines", headers=person.headers, json=body(**over))
    assert r.status_code == 201, r.text
    return r.json()


def get(o, person, did):
    return o.http.get(f"{API}/deadlines/{did}", headers=person.headers)


def patch(o, person, did, version, **fields):
    return o.http.patch(f"{API}/deadlines/{did}", headers=person.headers, json={"version": version, **fields})


def set_status(o, person, did, version, status, **extra):
    return o.http.post(f"{API}/deadlines/{did}/status", headers=person.headers,
                       json={"version": version, "status": status, **extra})


def listing(o, person, **params):
    params.setdefault("scope", "office")
    return o.http.get(f"{API}/deadlines", headers=person.headers, params=params)


def snapshot(o):
    """Estado integral dos dois módulos (dados e índices) para comparar rollback."""
    org, dl = o.store.state, o.app.state.org.deadline_store.state
    return (org, dl, {k: dict(v) for k, v in vars(org).items()}, {k: dict(v) for k, v in vars(dl).items()})
