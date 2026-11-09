"""Políticas PURAS de autorização da equipe (Etapa 3).

Recebem instantâneos lidos DENTRO da transação e devolvem `None` (permitido) ou um
`Denial` com status/código. Não acessam estado, relógio ou rede — fáceis de testar.

Matriz aprovada (ver docs/backend/07-etapa-3-escritorios-rbac.md):
- office.manage exige team.manage (invariante do conjunto);
- privilégios administrativos (team.manage, office.manage) só são concedidos ou
  retirados por quem tem office.manage;
- quem não tem office.manage não altera outros gestores ou administradores;
- delegação limitada ao que o ator possui: só concede permissões deadline.* que tem e
  só concede visibility=all se ele próprio tem all;
- ninguém amplia a própria visibilidade ou permissões;
- o escritório nunca fica sem administrador;
- cargo e created_by não concedem poderes;
- ingresso (emitir convite / aprovar solicitação) concede MEMBER_PERMISSIONS com
  visibility=assigned: exige team.manage E posse de todo esse conjunto.
"""
from __future__ import annotations

from dataclasses import dataclass

from app.domain.org import ADMINISTRATIVE, MEMBER_PERMISSIONS, PERMISSIONS, Membership


@dataclass(frozen=True)
class Denial:
    status: int
    code: str
    message: str


FORBIDDEN = Denial(403, "forbidden", "Operação não permitida.")
NOT_FOUND = Denial(404, "not_found", "Recurso não encontrado.")


def validate_permission_set(permissions: frozenset[str]) -> Denial | None:
    if not permissions:
        return Denial(422, "invalid_permission_set", "Informe ao menos uma permissão.")
    unknown = permissions - set(PERMISSIONS)
    if unknown:
        return Denial(422, "invalid_permission_set", "Permissão desconhecida.")
    if "office.manage" in permissions and "team.manage" not in permissions:
        return Denial(422, "invalid_permission_set", "office.manage exige team.manage.")
    return None


def can_manage_team(actor: Membership) -> Denial | None:
    return None if actor.is_manager else FORBIDDEN


def can_manage_office(actor: Membership) -> Denial | None:
    return None if actor.is_admin else FORBIDDEN


def can_grant_entry(actor: Membership) -> Denial | None:
    """Emitir convite ou aprovar solicitação equivale a conceder o conjunto de ingresso.

    Mesma regra de delegação de `check_member_change`: o ator precisa de team.manage e de
    TODAS as permissões de MEMBER_PERMISSIONS (visibility=assigned não exige `all`). O
    conjunto do novo membro nunca é reduzido em silêncio: sem autoridade, a operação é
    negada.
    """
    if (d := can_manage_team(actor)):
        return d
    if MEMBER_PERMISSIONS - actor.permissions:
        return Denial(
            403, "delegation_not_allowed",
            "Para admitir membros é preciso possuir todas as permissões concedidas no ingresso.",
        )
    return None


def can_touch_target(actor: Membership, target: Membership) -> Denial | None:
    """Gestor sem office.manage não altera outros gestores/administradores."""
    if actor.user_id != target.user_id and (target.is_manager or target.is_admin) and not actor.is_admin:
        return FORBIDDEN
    return None


def check_member_change(
    actor: Membership,
    target: Membership,
    *,
    new_permissions: frozenset[str] | None,
    new_visibility: str | None,
    admins_in_office: int,
) -> Denial | None:
    """Valida alteração de permissões/visibilidade (cargo e áreas só exigem os passos gerais)."""
    if (d := can_manage_team(actor)) or (d := can_touch_target(actor, target)):
        return d
    perms = target.permissions if new_permissions is None else new_permissions
    if (d := validate_permission_set(perms)):
        return d
    gained = perms - target.permissions
    lost = target.permissions - perms
    self_change = actor.user_id == target.user_id

    # Ninguém amplia o próprio acesso (permissões ou visibilidade).
    if self_change and gained:
        return Denial(403, "self_escalation_forbidden", "Não é possível ampliar as próprias permissões.")
    if self_change and new_visibility == "all" and target.visibility != "all":
        return Denial(403, "self_escalation_forbidden", "Não é possível ampliar a própria visibilidade.")

    # Privilégios administrativos: somente administrador concede ou retira.
    if (gained | lost) & ADMINISTRATIVE and not actor.is_admin:
        return Denial(403, "delegation_not_allowed", "Somente administradores alteram privilégios administrativos.")

    # Delegação limitada ao que o ator possui.
    if gained - actor.permissions:
        return Denial(403, "delegation_not_allowed", "Não é possível conceder permissões que você não possui.")
    if new_visibility == "all" and target.visibility != "all" and actor.visibility != "all":
        return Denial(403, "delegation_not_allowed", "Não é possível conceder visibilidade que você não possui.")

    # Último administrador.
    if target.is_admin and "office.manage" not in perms and admins_in_office <= 1:
        return Denial(409, "last_admin", "O escritório precisa manter ao menos um administrador.")
    return None


def check_promote(actor: Membership, target: Membership) -> Denial | None:
    if (d := can_manage_office(actor)):
        return d
    if actor.user_id == target.user_id:
        return Denial(409, "invalid_successor", "Escolha outro membro como sucessor.")
    return None


def check_remove(actor: Membership, target: Membership, admins_in_office: int) -> Denial | None:
    if (d := can_manage_team(actor)) or (d := can_touch_target(actor, target)):
        return d
    if actor.user_id == target.user_id:
        return Denial(409, "cannot_remove_self", "Para deixar o escritório, use a saída.")
    if target.is_admin and admins_in_office <= 1:
        return Denial(409, "last_admin", "O escritório precisa manter ao menos um administrador.")
    return None
