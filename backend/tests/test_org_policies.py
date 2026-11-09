"""Etapa 3 — políticas puras da matriz de autorização (sem estado, sem HTTP)."""
from datetime import datetime, timezone

import pytest

from app.domain.org import ADMIN_PERMISSIONS, MEMBER_PERMISSIONS, Membership
from app.policies import org as policy

NOW = datetime(2026, 11, 9, tzinfo=timezone.utc)
MANAGER = frozenset(MEMBER_PERMISSIONS | {"team.manage"})


def m(uid, perms, vis="assigned"):
    return Membership(uid, "off", "Cargo", (), frozenset(perms), vis, NOW)


def change(actor, target, perms=None, vis=None, admins=1):
    return policy.check_member_change(
        actor, target, new_permissions=None if perms is None else frozenset(perms), new_visibility=vis,
        admins_in_office=admins,
    )


ADMIN = m("admin", ADMIN_PERMISSIONS, "all")
MGR = m("mgr", MANAGER, "assigned")
MGR_ALL = m("mgr2", MANAGER, "all")
MEM = m("mem", MEMBER_PERMISSIONS)


def code(d):
    return None if d is None else d.code


# ---------- conjunto de permissões ----------
@pytest.mark.parametrize("perms,expected", [
    (set(), "invalid_permission_set"),
    ({"deadline.hack"}, "invalid_permission_set"),
    ({"office.manage"}, "invalid_permission_set"),             # office.manage exige team.manage
    ({"office.manage", "deadline.read"}, "invalid_permission_set"),
    ({"office.manage", "team.manage"}, None),
    ({"deadline.read"}, None),
])
def test_validacao_do_conjunto(perms, expected):
    assert code(policy.validate_permission_set(frozenset(perms))) == expected


# ---------- quem pode o quê ----------
def test_membro_comum_nao_gerencia_equipe():
    assert code(change(MEM, m("x", MEMBER_PERMISSIONS), perms={"deadline.read"})) == "forbidden"


def test_gestor_altera_membro_comum_dentro_do_que_possui():
    assert change(MGR, MEM, perms={"deadline.read"}) is None
    assert change(MGR, MEM, perms=MEMBER_PERMISSIONS) is None


def test_gestor_nao_concede_permissao_que_nao_possui():
    assert code(change(MGR, MEM, perms=MEMBER_PERMISSIONS | {"deadline.transfer"})) == "delegation_not_allowed"


def test_gestor_nao_concede_nem_retira_privilegio_administrativo():
    assert code(change(MGR, MEM, perms=MEMBER_PERMISSIONS | {"team.manage"})) == "delegation_not_allowed"
    assert code(change(MGR, MEM, perms={"team.manage", "office.manage", "deadline.read"})) == "delegation_not_allowed"


def test_gestor_nao_altera_outro_gestor_nem_administrador():
    assert code(change(MGR, MGR_ALL, perms={"deadline.read"})) == "forbidden"
    assert code(change(MGR, ADMIN, perms=ADMIN_PERMISSIONS - {"deadline.transfer"})) == "forbidden"
    assert code(change(MGR, MGR_ALL, vis="assigned")) == "forbidden"


def test_gestor_assigned_nao_concede_visibilidade_all():
    assert code(change(MGR, MEM, vis="all")) == "delegation_not_allowed"
    assert change(MGR_ALL, MEM, vis="all") is None
    assert change(MGR, m("y", MEMBER_PERMISSIONS, "all"), vis="assigned") is None   # reduzir é permitido


def test_ninguem_amplia_o_proprio_acesso():
    assert code(change(MEM, MEM, perms=MEMBER_PERMISSIONS | {"deadline.transfer"})) == "forbidden"
    assert code(change(MGR, MGR, perms=MANAGER | {"deadline.transfer"})) == "self_escalation_forbidden"
    assert code(change(MGR, MGR, vis="all")) == "self_escalation_forbidden"
    limited_admin = m("adm", ADMIN_PERMISSIONS - {"deadline.transfer"}, "assigned")
    assert code(change(limited_admin, limited_admin, perms=ADMIN_PERMISSIONS, admins=2)) == "self_escalation_forbidden"
    assert code(change(limited_admin, limited_admin, vis="all", admins=2)) == "self_escalation_forbidden"


def test_reduzir_o_proprio_acesso_e_permitido_salvo_privilegio_administrativo_do_gestor():
    assert change(MGR, MGR, perms=MANAGER - {"deadline.edit"}) is None
    assert change(MGR_ALL, MGR_ALL, vis="assigned") is None
    # retirar o próprio team.manage é alteração de privilégio administrativo → só administrador
    assert code(change(MGR, MGR, perms=MEMBER_PERMISSIONS)) == "delegation_not_allowed"


def test_administrador_concede_e_retira_privilegios_administrativos():
    assert change(ADMIN, MEM, perms=MEMBER_PERMISSIONS | {"team.manage"}) is None
    assert change(ADMIN, MGR, perms=MEMBER_PERMISSIONS) is None
    other_admin = m("adm2", ADMIN_PERMISSIONS, "all")
    assert change(ADMIN, other_admin, perms=MANAGER, admins=2) is None


def test_administrador_tambem_so_delega_o_que_possui():
    limited_admin = m("adm", ADMIN_PERMISSIONS - {"deadline.transfer"}, "assigned")
    granted = MEMBER_PERMISSIONS | {"deadline.transfer"}
    assert code(change(limited_admin, MEM, perms=granted)) == "delegation_not_allowed"
    assert code(change(limited_admin, MEM, vis="all")) == "delegation_not_allowed"


def test_ultimo_administrador_preservado():
    assert code(change(ADMIN, ADMIN, perms=MANAGER, admins=1)) == "last_admin"
    assert change(ADMIN, ADMIN, perms=MANAGER, admins=2) is None


def test_cargo_nao_concede_poder():
    called_admin = Membership("x", "off", "Administrador", (), MEMBER_PERMISSIONS, "assigned", NOW)
    assert code(change(called_admin, MEM, perms={"deadline.read"})) == "forbidden"


def test_escalada_indireta_entre_dois_gestores_bloqueada():
    """A (gestor) tenta dar a B o que A não tem, e B tenta devolver a A: ambos negados."""
    a = m("a", MANAGER, "assigned")
    b = m("b", MANAGER, "assigned")
    assert code(change(a, b, perms=MANAGER | {"deadline.transfer"})) == "forbidden"
    assert code(change(b, a, vis="all")) == "forbidden"
    member = m("c", MEMBER_PERMISSIONS)
    assert code(change(a, member, perms=MEMBER_PERMISSIONS | {"team.manage"})) == "delegation_not_allowed"


# ---------- promoção e remoção ----------
def test_promocao_e_remocao():
    assert code(policy.check_promote(MGR, MEM)) == "forbidden"
    assert code(policy.check_promote(ADMIN, ADMIN)) == "invalid_successor"
    assert policy.check_promote(ADMIN, MEM) is None
    assert code(policy.check_remove(MEM, MGR, 1)) == "forbidden"
    assert code(policy.check_remove(MGR, ADMIN, 1)) == "forbidden"
    assert code(policy.check_remove(MGR, MGR_ALL, 1)) == "forbidden"
    assert policy.check_remove(MGR, MEM, 1) is None
    assert code(policy.check_remove(ADMIN, ADMIN, 2)) == "cannot_remove_self"
    other_admin = m("adm2", ADMIN_PERMISSIONS, "all")
    assert code(policy.check_remove(ADMIN, other_admin, 1)) == "last_admin"
    assert policy.check_remove(ADMIN, other_admin, 2) is None
