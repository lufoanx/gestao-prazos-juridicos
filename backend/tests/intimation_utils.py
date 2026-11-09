"""Auxiliares dos testes da Etapa 5 (intimações e notificações). Sem segredos reais."""
from __future__ import annotations

from tests.org_utils import API


def reg_body(**over):
    data = {"scope": "office", "fileName": "intimacao.pdf", "sizeBytes": 2048, "contentType": "application/pdf",
            "receivedAt": "2026-11-09"}
    data.update(over)
    return {k: v for k, v in data.items() if v is not None}


def register(o, person, **over):
    r = o.http.post(f"{API}/intimations", headers=person.headers, json=reg_body(**over))
    assert r.status_code == 201, r.text
    return r.json()


def confirm_body(version, **over):
    data = {"version": version, "title": "Contestação", "caseNumber": "0001234-56.2026", "court": "TJSC 2ª Vara",
            "practiceArea": "Cível", "startDate": "2026-11-09", "dueDate": "2026-11-20",
            "countingMode": "business", "duration": 10}
    data.update(over)
    return {k: v for k, v in data.items() if v is not None}


def confirm(o, person, iid, version, **over):
    return o.http.post(f"{API}/intimations/{iid}/confirm", headers=person.headers, json=confirm_body(version, **over))


def get_i(o, person, iid):
    return o.http.get(f"{API}/intimations/{iid}", headers=person.headers)


def notifications(o, person, scope="office", **params):
    return o.http.get(f"{API}/notifications", headers=person.headers, params={"scope": scope, **params})


def unread(o, person, scope="office"):
    return o.http.get(f"{API}/notifications/unread-count", headers=person.headers, params={"scope": scope}).json()


def full_state(o):
    """Estado integral dos quatro armazenamentos (referências e conteúdo, incluindo índices)."""
    uow = o.app.state.org.unit_of_work
    stores = (uow.org_store, uow.deadline_store, uow.intimation_store, uow.notification_store)
    refs = tuple(st.state for st in stores)
    content = tuple({k: dict(v) for k, v in vars(st.state).items()} for st in stores)
    return refs, content


class ControlledProcessing:
    """Adaptador de processamento CONTROLADO (só testes): registra pedidos; não processa nada."""

    def __init__(self):
        self.available = True
        self.requested: list[str] = []

    def request(self, intimation_id):
        self.requested.append(intimation_id)
