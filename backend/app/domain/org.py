"""Entidades de escritório, vínculo, convite e solicitação (Etapa 3, sem ORM).

Cargo (`role_label`), áreas (`practice_areas`), permissões e visibilidade são dimensões
independentes. Nenhum cargo e nenhum `created_by` concedem poderes: a autoridade vem
exclusivamente do conjunto de permissões do vínculo atual.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Literal

PERMISSIONS: tuple[str, ...] = (
    "deadline.read",
    "deadline.create",
    "deadline.edit",
    "deadline.complete",
    "deadline.transfer",
    "team.manage",
    "office.manage",
)
ADMIN_PERMISSIONS: frozenset[str] = frozenset(PERMISSIONS)
# Ingresso comum (convite ou aprovação): conjunto MEMBER_PERMS de frontend/src/lib/org-ops.mjs.
# Diverge de MEMBER_PERMISSIONS de session.mjs (sem deadline.edit) — ver doc 07.
MEMBER_PERMISSIONS: frozenset[str] = frozenset(
    {"deadline.read", "deadline.create", "deadline.edit", "deadline.complete"}
)
ADMINISTRATIVE: frozenset[str] = frozenset({"team.manage", "office.manage"})

# Código de ingresso: Crockford base32 (sem I, L, O, U), 10 caracteres ≈ 50 bits.
JOIN_CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
JOIN_CODE_LENGTH = 10

Visibility = Literal["all", "assigned"]
InvitationStatus = Literal["pending", "accepted", "revoked"]
InvitationState = Literal["valid", "expired", "used", "revoked", "invalid"]
JoinRequestStatus = Literal["pending", "approved", "rejected", "cancelled"]


@dataclass(frozen=True)
class Office:
    id: str
    name: str
    created_by: str  # informativo (auditoria); NÃO concede poderes
    created_at: datetime
    join_code: str  # código de ingresso: só permite SOLICITAR; não é segredo de acesso


@dataclass(frozen=True)
class Membership:
    user_id: str
    office_id: str
    role_label: str
    practice_areas: tuple[str, ...]
    permissions: frozenset[str]
    visibility: Visibility
    joined_at: datetime

    def has(self, permission: str) -> bool:
        return permission in self.permissions

    @property
    def is_admin(self) -> bool:
        return "office.manage" in self.permissions

    @property
    def is_manager(self) -> bool:
        return "team.manage" in self.permissions


@dataclass(frozen=True)
class Invitation:
    id: str
    office_id: str
    token_hash: str  # SHA-256; o token em claro só existe na resposta de criação
    role_label: str
    created_by: str
    created_at: datetime
    expires_at: datetime
    status: InvitationStatus = "pending"
    closed_at: datetime | None = None  # aceito ou revogado

    def state(self, now: datetime) -> InvitationState:
        if self.status == "revoked":
            return "revoked"
        if self.status == "accepted":
            return "used"
        if now >= self.expires_at:
            return "expired"
        return "valid"

    def __repr__(self) -> str:
        return f"Invitation(id={self.id!r}, office_id={self.office_id!r}, status={self.status!r})"


@dataclass(frozen=True)
class JoinRequest:
    id: str
    office_id: str
    user_id: str  # referência ao usuário; nome/e-mail NÃO são copiados
    created_at: datetime
    status: JoinRequestStatus = "pending"
    decided_at: datetime | None = None
    decided_by: str | None = None  # gestor que aprovou/rejeitou; None em cancelamento
