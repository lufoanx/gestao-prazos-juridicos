"""Repositório de escritórios EM MEMÓRIA (Etapas 3 e 4).

Mesmas ressalvas da Etapa 2: perde tudo ao reiniciar, um estado por processo (não use
múltiplos workers) e bloqueado em production.

Transações (Etapa 4): ESCRITAS PREPARADAS com copy-on-write (`memory_tx.Fork`). O
`RLock` garante exclusão mútua; o rollback é real: nada do estado confirmado muda até a
publicação, que troca uma única referência. Operações que também tocam prazos usam a
unidade de trabalho (`unit_of_work.MemoryUnitOfWork`), com ordem de locks fixa
escritórios → prazos.

Retenção: convites aceitos/revogados/expirados e solicitações encerradas são removidos
quando passam de `closed_retention` (varredura no início das transações, no máximo a
cada `purge_interval`; a varredura também é confirmada só no commit).
"""
from __future__ import annotations

import threading
from dataclasses import dataclass
from datetime import datetime, timedelta

from app.domain.errors import JoinCodeCollisionError
from app.domain.org import Invitation, JoinRequest, Membership, Office
from app.repositories.memory_tx import Fork, add_to_index, empty_state, remove_from_index


@dataclass(frozen=True)
class OrgState:
    offices: dict[str, Office]
    office_by_code: dict[str, str]
    membership_by_user: dict[str, Membership]
    members_by_office: dict[str, frozenset[str]]
    invitations: dict[str, Invitation]
    invitation_by_hash: dict[str, str]
    invitations_by_office: dict[str, frozenset[str]]
    requests: dict[str, JoinRequest]
    requests_by_office: dict[str, frozenset[str]]
    requests_by_user: dict[str, frozenset[str]]


class MemoryOrgStore:
    def __init__(self, *, closed_retention_seconds: int, purge_interval_seconds: int = 60) -> None:
        if closed_retention_seconds < 1:
            raise ValueError("closed_retention_seconds deve ser >= 1")
        self.lock = threading.RLock()
        self.closed_retention = timedelta(seconds=closed_retention_seconds)
        self.purge_interval = timedelta(seconds=purge_interval_seconds)
        self.last_purge: datetime | None = None
        self.state: OrgState = empty_state(OrgState)

    # Acesso de leitura ao estado CONFIRMADO (diagnóstico e testes).
    @property
    def offices(self) -> dict[str, Office]:
        return self.state.offices

    @property
    def office_by_code(self) -> dict[str, str]:
        return self.state.office_by_code

    @property
    def membership_by_user(self) -> dict[str, Membership]:
        return self.state.membership_by_user

    @property
    def members_by_office(self) -> dict[str, frozenset[str]]:
        return self.state.members_by_office

    @property
    def invitations(self) -> dict[str, Invitation]:
        return self.state.invitations

    @property
    def invitations_by_office(self) -> dict[str, frozenset[str]]:
        return self.state.invitations_by_office

    @property
    def requests(self) -> dict[str, JoinRequest]:
        return self.state.requests

    @property
    def requests_by_office(self) -> dict[str, frozenset[str]]:
        return self.state.requests_by_office

    @property
    def requests_by_user(self) -> dict[str, frozenset[str]]:
        return self.state.requests_by_user


class MemoryOrgTransaction:
    def lock_anchors(self, *, office_ids: tuple[str, ...] = (), user_ids: tuple[str, ...] = ()) -> None:
        return None  # locks globais da memória já adquiridos

    """Visão transacional (escritas preparadas) — só existe com o lock de escritórios adquirido."""

    def __init__(self, store: MemoryOrgStore, now: datetime, *, allow_membership_delete: bool) -> None:
        self._store = store
        self._f: Fork[OrgState] = Fork(store.state)
        self.now = now
        self._allow_delete = allow_membership_delete
        self.removed_memberships: list[Membership] = []
        self.purged = False

    # ---- ciclo de vida ----
    @property
    def changed(self) -> bool:
        return self._f.changed

    def build(self) -> OrgState:
        return self._f.build()

    def maybe_purge(self) -> None:
        s = self._store
        if s.last_purge is None or self.now - s.last_purge >= s.purge_interval:
            self.purge()

    def purge(self) -> int:
        removed = 0
        retention = self._store.closed_retention
        for inv in list(self._f.r("invitations").values()):
            closed_since = inv.closed_at if inv.status != "pending" and inv.closed_at else inv.expires_at
            if (inv.status != "pending" or self.now >= inv.expires_at) and self.now - closed_since >= retention:
                del self._f.w("invitations")[inv.id]
                self._f.w("invitation_by_hash").pop(inv.token_hash, None)
                remove_from_index(self._f.w("invitations_by_office"), inv.office_id, inv.id)
                removed += 1
        for req in list(self._f.r("requests").values()):
            if req.status != "pending" and req.decided_at is not None and self.now - req.decided_at >= retention:
                del self._f.w("requests")[req.id]
                remove_from_index(self._f.w("requests_by_office"), req.office_id, req.id)
                remove_from_index(self._f.w("requests_by_user"), req.user_id, req.id)
                removed += 1
        self.purged = True
        return removed

    # ---- escritórios ----
    def get_office(self, office_id: str) -> Office | None:
        return self._f.r("offices").get(office_id)

    def get_office_by_code(self, code: str) -> Office | None:
        oid = self._f.r("office_by_code").get(code)
        return self.get_office(oid) if oid else None

    def code_in_use(self, code: str) -> bool:
        return code in self._f.r("office_by_code")

    def put_office(self, office: Office) -> None:
        previous = self.get_office(office.id)
        owner = self._f.r("office_by_code").get(office.join_code, office.id)
        if owner != office.id:
            raise JoinCodeCollisionError()
        if previous is not None and previous.join_code != office.join_code:
            self._f.w("office_by_code").pop(previous.join_code, None)
        self._f.w("offices")[office.id] = office
        self._f.w("office_by_code")[office.join_code] = office.id

    # ---- vínculos ----
    def membership_of_user(self, user_id: str) -> Membership | None:
        return self._f.r("membership_by_user").get(user_id)

    def members_of(self, office_id: str) -> list[Membership]:
        ids = self._f.r("members_by_office").get(office_id, frozenset())
        by_user = self._f.r("membership_by_user")
        return [by_user[u] for u in ids]

    def count_admins(self, office_id: str) -> int:
        return sum(1 for m in self.members_of(office_id) if m.is_admin)

    def put_membership(self, membership: Membership) -> None:
        current = self.membership_of_user(membership.user_id)
        if current is not None and current.office_id != membership.office_id:
            # Invariante de escritório único: nunca troca vínculo silenciosamente.
            raise ValueError("pessoa já possui vínculo com outro escritório")
        self._f.w("membership_by_user")[membership.user_id] = membership
        add_to_index(self._f.w("members_by_office"), membership.office_id, membership.user_id)

    def delete_membership(self, user_id: str) -> None:
        if not self._allow_delete:
            raise RuntimeError("remoção de vínculo exige a unidade de trabalho com prazos")
        m = self.membership_of_user(user_id)
        if m is None:
            return
        del self._f.w("membership_by_user")[user_id]
        remove_from_index(self._f.w("members_by_office"), m.office_id, user_id)
        self.removed_memberships.append(m)

    # ---- convites ----
    def get_invitation(self, invitation_id: str) -> Invitation | None:
        return self._f.r("invitations").get(invitation_id)

    def get_invitation_by_hash(self, token_hash: str) -> Invitation | None:
        iid = self._f.r("invitation_by_hash").get(token_hash)
        return self.get_invitation(iid) if iid else None

    def invitations_of(self, office_id: str) -> list[Invitation]:
        invs = self._f.r("invitations")
        return [invs[i] for i in self._f.r("invitations_by_office").get(office_id, frozenset())]

    def put_invitation(self, invitation: Invitation) -> None:
        self._f.w("invitations")[invitation.id] = invitation
        self._f.w("invitation_by_hash")[invitation.token_hash] = invitation.id
        add_to_index(self._f.w("invitations_by_office"), invitation.office_id, invitation.id)

    # ---- solicitações ----
    def get_request(self, request_id: str) -> JoinRequest | None:
        return self._f.r("requests").get(request_id)

    def requests_of_office(self, office_id: str) -> list[JoinRequest]:
        reqs = self._f.r("requests")
        return [reqs[r] for r in self._f.r("requests_by_office").get(office_id, frozenset())]

    def requests_of_user(self, user_id: str) -> list[JoinRequest]:
        reqs = self._f.r("requests")
        return [reqs[r] for r in self._f.r("requests_by_user").get(user_id, frozenset())]

    def put_request(self, request: JoinRequest) -> None:
        self._f.w("requests")[request.id] = request
        add_to_index(self._f.w("requests_by_office"), request.office_id, request.id)
        add_to_index(self._f.w("requests_by_user"), request.user_id, request.id)
