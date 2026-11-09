"""Auxiliares dos testes da Etapa 3 (escritórios/equipe). Sem segredos reais."""
from __future__ import annotations

from dataclasses import dataclass

import pytest
from fastapi.testclient import TestClient

API = "/api/v1"
PASSWORD = "Senha-de-teste-123"
ALL = ["deadline.read", "deadline.create", "deadline.edit", "deadline.complete",
       "deadline.transfer", "team.manage", "office.manage"]
MEMBER = ["deadline.read", "deadline.create", "deadline.edit", "deadline.complete"]


@dataclass
class Person:
    id: str
    email: str
    headers: dict


class OrgClient:
    def __init__(self, app) -> None:
        self.app = app
        self.http = TestClient(app, raise_server_exceptions=False)
        self._n = 0

    @property
    def service(self):
        return self.app.state.org.service

    @property
    def store(self):
        return self.app.state.org.store

    def person(self, name: str | None = None) -> Person:
        self._n += 1
        name = name or f"pessoa{self._n}"
        email = f"{name}@exemplo.com"
        r = self.http.post(f"{API}/auth/register", json={"name": name.title(), "email": email, "password": PASSWORD})
        assert r.status_code == 201, r.text
        tokens = self.http.post(f"{API}/auth/login", json={"email": email, "password": PASSWORD}).json()
        return Person(r.json()["id"], email, {"Authorization": f"Bearer {tokens['accessToken']}"})

    def relogin(self, person: Person) -> Person:
        """Novo access token (o relógio injetado pode ter expirado o anterior)."""
        tokens = self.http.post(f"{API}/auth/login", json={"email": person.email, "password": PASSWORD}).json()
        person.headers = {"Authorization": f"Bearer {tokens['accessToken']}"}
        return person

    def office(self, owner: Person, name: str = "Escritório Teste") -> str:
        r = self.http.post(f"{API}/offices", headers=owner.headers, json={"name": name})
        assert r.status_code == 201, r.text
        return r.json()["office"]["id"]

    def invite(self, actor: Person, office_id: str, role: str = "Membro") -> str:
        r = self.http.post(f"{API}/offices/{office_id}/invitations", headers=actor.headers, json={"roleLabel": role})
        assert r.status_code == 201, r.text
        return r.json()["token"]

    def join(self, actor: Person, office_id: str, person: Person, role: str = "Membro") -> None:
        token = self.invite(actor, office_id, role)
        r = self.http.post(f"{API}/invitations/accept", headers=person.headers, json={"token": token})
        assert r.status_code == 200, r.text

    def set_perms(self, actor: Person, office_id: str, target: Person, perms, visibility=None):
        body = {"permissions": perms}
        if visibility:
            body["visibility"] = visibility
        return self.http.patch(f"{API}/offices/{office_id}/members/{target.id}", headers=actor.headers, json=body)

    def membership(self, person: Person):
        return self.store.membership_by_user.get(person.id)


def fast_hasher():
    """Argon2id REAL com parâmetros mínimos: a autenticação não é o objeto destes testes.

    Os testes da Etapa 2 continuam usando os parâmetros padrão (RFC 9106).
    """
    from argon2 import PasswordHasher as Argon2Hasher
    from argon2 import Type

    from app.security.passwords import PasswordHasher

    return PasswordHasher(Argon2Hasher(type=Type.ID, time_cost=1, memory_cost=8, parallelism=1))


@pytest.fixture
def org(make_app, clock, delivery):
    def _org(**env):
        env.setdefault("AUTH_REGISTER_MAX_REQUESTS", 1000)
        port = env.pop("responsibility_port", None)
        return OrgClient(
            make_app(clock=clock, delivery=delivery, responsibility_port=port, password_hasher=fast_hasher(), **env)
        )

    return _org
