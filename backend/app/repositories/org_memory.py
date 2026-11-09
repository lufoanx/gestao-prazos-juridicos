"""Repositório de escritórios EM MEMÓRIA (Etapa 3).

Mesmas ressalvas da Etapa 2: perde tudo ao reiniciar, um estado por processo (não use
múltiplos workers) e bloqueado em production. O estado pertence à instância de
`MemoryOrgStore`, criada por `create_app`.

Transação: `transaction()` mantém o `RLock` da instância durante todo o bloco, de modo
que leitura da autorização, verificação de invariantes e escrita são uma unidade. O
serviço valida tudo antes de escrever (nenhuma escrita parcial em caso de erro).
Nenhuma operação cara (hash de senha etc.) acontece dentro do lock.

Retenção: convites aceitos/revogados/expirados e solicitações encerradas são removidos
quando passam de `closed_retention` (varredura no início das transações, no máximo a
cada `purge_interval`). Registros pendentes são limitados por tetos no serviço.
"""
from __future__ import annotations

import threading
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import datetime, timedelta

from app.core.clock import Clock
from app.domain.org import Invitation, JoinRequest, Membership, Office


class MemoryOrgStore:
    def __init__(self, *, closed_retention_seconds: int, purge_interval_seconds: int = 60) -> None:
        if closed_retention_seconds < 1:
            raise ValueError("closed_retention_seconds deve ser >= 1")
        self.lock = threading.RLock()
        self.closed_retention = timedelta(seconds=closed_retention_seconds)
        self.purge_interval = timedelta(seconds=purge_interval_seconds)
        self.last_purge: datetime | None = None
        self.offices: dict[str, Office] = {}
        self.office_by_code: dict[str, str] = {}
        self.membership_by_user: dict[str, Membership] = {}
        self.members_by_office: dict[str, set[str]] = {}
        self.invitations: dict[str, Invitation] = {}
        self.invitation_by_hash: dict[str, str] = {}
        self.invitations_by_office: dict[str, set[str]] = {}
        self.requests: dict[str, JoinRequest] = {}
        self.requests_by_office: dict[str, set[str]] = {}
        self.requests_by_user: dict[str, set[str]] = {}

    # ---- retenção (com lock) ----
    def purge_locked(self, now: datetime) -> int:
        removed = 0
        for inv_id in list(self.invitations):
            inv = self.invitations[inv_id]
            closed_since = inv.closed_at if inv.status != "pending" and inv.closed_at else inv.expires_at
            if (inv.status != "pending" or now >= inv.expires_at) and now - closed_since >= self.closed_retention:
                del self.invitations[inv_id]
                self.invitation_by_hash.pop(inv.token_hash, None)
                self.invitations_by_office.get(inv.office_id, set()).discard(inv_id)
                removed += 1
        for req_id in list(self.requests):
            req = self.requests[req_id]
            if req.status != "pending" and req.decided_at is not None and now - req.decided_at >= self.closed_retention:
                del self.requests[req_id]
                self.requests_by_office.get(req.office_id, set()).discard(req_id)
                self.requests_by_user.get(req.user_id, set()).discard(req_id)
                removed += 1
        for index in (self.invitations_by_office, self.requests_by_office, self.requests_by_user):
            for key in [k for k, v in index.items() if not v]:
                del index[key]
        self.last_purge = now
        return removed


class MemoryOrgTransaction:
    """Visão transacional do store (só existe enquanto o lock está adquirido)."""

    def __init__(self, store: MemoryOrgStore, now: datetime) -> None:
        self._s = store
        self.now = now

    # Escritórios
    def get_office(self, office_id: str) -> Office | None:
        return self._s.offices.get(office_id)

    def get_office_by_code(self, code: str) -> Office | None:
        oid = self._s.office_by_code.get(code)
        return self._s.offices.get(oid) if oid else None

    def code_in_use(self, code: str) -> bool:
        return code in self._s.office_by_code

    def put_office(self, office: Office) -> None:
        previous = self._s.offices.get(office.id)
        if previous is not None and previous.join_code != office.join_code:
            self._s.office_by_code.pop(previous.join_code, None)
        if self._s.office_by_code.get(office.join_code, office.id) != office.id:
            raise ValueError("código de ingresso já em uso")
        self._s.offices[office.id] = office
        self._s.office_by_code[office.join_code] = office.id

    # Vínculos
    def membership_of_user(self, user_id: str) -> Membership | None:
        return self._s.membership_by_user.get(user_id)

    def members_of(self, office_id: str) -> list[Membership]:
        ids = self._s.members_by_office.get(office_id, set())
        return [self._s.membership_by_user[u] for u in ids]

    def count_admins(self, office_id: str) -> int:
        return sum(1 for m in self.members_of(office_id) if m.is_admin)

    def put_membership(self, membership: Membership) -> None:
        current = self._s.membership_by_user.get(membership.user_id)
        if current is not None and current.office_id != membership.office_id:
            # Invariante de escritório único: nunca troca vínculo silenciosamente.
            raise ValueError("pessoa já possui vínculo com outro escritório")
        self._s.membership_by_user[membership.user_id] = membership
        self._s.members_by_office.setdefault(membership.office_id, set()).add(membership.user_id)

    def delete_membership(self, user_id: str) -> None:
        m = self._s.membership_by_user.pop(user_id, None)
        if m is not None:
            ids = self._s.members_by_office.get(m.office_id)
            if ids is not None:
                ids.discard(user_id)

    # Convites
    def get_invitation(self, invitation_id: str) -> Invitation | None:
        return self._s.invitations.get(invitation_id)

    def get_invitation_by_hash(self, token_hash: str) -> Invitation | None:
        iid = self._s.invitation_by_hash.get(token_hash)
        return self._s.invitations.get(iid) if iid else None

    def invitations_of(self, office_id: str) -> list[Invitation]:
        return [self._s.invitations[i] for i in self._s.invitations_by_office.get(office_id, set())]

    def put_invitation(self, invitation: Invitation) -> None:
        self._s.invitations[invitation.id] = invitation
        self._s.invitation_by_hash[invitation.token_hash] = invitation.id
        self._s.invitations_by_office.setdefault(invitation.office_id, set()).add(invitation.id)

    # Solicitações
    def get_request(self, request_id: str) -> JoinRequest | None:
        return self._s.requests.get(request_id)

    def requests_of_office(self, office_id: str) -> list[JoinRequest]:
        return [self._s.requests[r] for r in self._s.requests_by_office.get(office_id, set())]

    def requests_of_user(self, user_id: str) -> list[JoinRequest]:
        return [self._s.requests[r] for r in self._s.requests_by_user.get(user_id, set())]

    def put_request(self, request: JoinRequest) -> None:
        self._s.requests[request.id] = request
        self._s.requests_by_office.setdefault(request.office_id, set()).add(request.id)
        self._s.requests_by_user.setdefault(request.user_id, set()).add(request.id)


class InMemoryOrgRepository:
    def __init__(self, store: MemoryOrgStore) -> None:
        self._s = store

    @contextmanager
    def transaction(self, clock: Clock) -> Iterator[MemoryOrgTransaction]:
        with self._s.lock:
            now = clock.now()  # lido DEPOIS de adquirir o lock
            if self._s.last_purge is None or now - self._s.last_purge >= self._s.purge_interval:
                self._s.purge_locked(now)
            yield MemoryOrgTransaction(self._s, now)

    def purge(self, now: datetime) -> int:
        with self._s.lock:
            return self._s.purge_locked(now)
