"""Políticas PURAS de acesso a prazos (Etapa 4).

Leitura:
- pessoal: somente o proprietário (nenhum administrador de escritório);
- escritório: vínculo ATUAL no mesmo escritório + deadline.read + (visibility=all ou
  ser o responsável).
Escrita em prazo existente: leitura + permissão da operação (pessoal: o dono pode tudo).
Sem leitura → 404 (não revela existência); com leitura e sem permissão → 403.
office.manage, team.manage, cargo e createdBy NÃO concedem acesso a prazos.
"""
from __future__ import annotations

from app.domain.deadlines import Deadline, ScopeKind
from app.domain.org import Membership
from app.policies.org import FORBIDDEN, NOT_FOUND, Denial

OP_PERMISSION = {
    "create": "deadline.create",
    "edit": "deadline.edit",
    "status": "deadline.complete",
    "comment": "deadline.create",
    "transfer": "deadline.transfer",
}

DELEGATION = Denial(403, "delegation_not_allowed", "Com visibilidade restrita, só é possível atribuir a si mesmo.")
RESPONSIBLE_INVALID = Denial(422, "responsible_invalid", "Responsável inválido para este ambiente.")


def can_read(user_id: str, membership: Membership | None, d: Deadline) -> bool:
    if d.scope.kind == "personal":
        return d.scope.owner_id == user_id
    if membership is None or membership.office_id != d.scope.office_id:
        return False
    if not membership.has("deadline.read"):
        return False
    return membership.visibility == "all" or d.responsible_id == user_id


def check_write(user_id: str, membership: Membership | None, d: Deadline, *perms: str) -> Denial | None:
    if not can_read(user_id, membership, d):
        return NOT_FOUND
    if d.scope.kind == "personal":
        return None
    assert membership is not None
    return None if all(membership.has(p) for p in perms) else FORBIDDEN


def check_create(user_id: str, membership: Membership | None, kind: ScopeKind) -> Denial | None:
    if kind == "personal":
        return None
    if membership is None:
        return NOT_FOUND
    if not (membership.has("deadline.read") and membership.has("deadline.create")):
        return FORBIDDEN
    return None


def check_assignment(
    user_id: str, membership: Membership | None, kind: ScopeKind, responsible_id: str
) -> Denial | None:
    """Quem pode ser posto como responsável (autorização; a validade do alvo é verificada na transação)."""
    if kind == "personal":
        return None if responsible_id == user_id else RESPONSIBLE_INVALID
    assert membership is not None
    if responsible_id != user_id and membership.visibility != "all":
        return DELEGATION
    return None


def check_transfer(user_id: str, membership: Membership | None, d: Deadline, office_id: str) -> Denial | None:
    if not can_read(user_id, membership, d):
        return NOT_FOUND
    if d.scope.kind != "personal":
        return Denial(409, "not_transferable", "Somente prazos pessoais podem ser transferidos ao escritório.")
    if membership is None or membership.office_id != office_id:
        return NOT_FOUND
    if not (membership.has("deadline.transfer") and membership.has("deadline.read")):
        return FORBIDDEN
    return None
