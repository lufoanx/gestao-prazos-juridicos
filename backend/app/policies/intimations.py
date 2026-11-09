"""Políticas PURAS de acesso a intimações (Etapa 5).

Pessoal: somente o dono. Escritório: vínculo ATUAL no mesmo escritório + deadline.read e:
- visibility=all; ou
- autor (createdBy); ou
- intimação PENDENTE (processing/awaiting_review/failed) com responsável sugerido = ator; ou
- intimação REVISADA cujo prazo vinculado tem o ator como responsável ATUAL (Issue #5).
Depois da revisão, a sugestão antiga não concede acesso por si só. Descartadas: só
visibility=all ou autor. Escrita: leitura + deadline.create (descartar/tentar de novo também
exige ser autor ou ter visibility=all). Gestão de equipe, cargo e createdBy de prazo não
concedem nada além disso.
"""
from __future__ import annotations

from app.domain.intimations import Intimation
from app.domain.org import Membership
from app.policies.org import FORBIDDEN, NOT_FOUND, Denial


def can_read(user_id: str, m: Membership | None, i: Intimation, linked_responsible_id: str | None) -> bool:
    if i.scope.kind == "personal":
        return i.scope.owner_id == user_id
    if m is None or m.office_id != i.scope.office_id or not m.has("deadline.read"):
        return False
    if m.visibility == "all" or i.created_by == user_id:
        return True
    if i.pending:
        return i.suggested_responsible_id == user_id
    if i.status == "reviewed":
        return linked_responsible_id == user_id
    return False


def check_write(
    user_id: str, m: Membership | None, i: Intimation, linked_responsible_id: str | None, *, owner_or_all: bool = False
) -> Denial | None:
    if not can_read(user_id, m, i, linked_responsible_id):
        return NOT_FOUND
    if i.scope.kind == "personal":
        return None
    assert m is not None
    if not m.has("deadline.create"):
        return FORBIDDEN
    if owner_or_all and not (i.created_by == user_id or m.visibility == "all"):
        return FORBIDDEN
    return None
