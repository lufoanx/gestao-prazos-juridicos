"""Etapa 4 — políticas puras de acesso a prazos."""
from datetime import date, datetime, timezone

from app.domain.deadlines import Deadline, Scope
from app.domain.org import ADMIN_PERMISSIONS, MEMBER_PERMISSIONS, Membership
from app.policies import deadlines as policy

NOW = datetime(2026, 11, 9, tzinfo=timezone.utc)


def m(uid, perms, vis="assigned", office="off"):
    return Membership(uid, office, "Cargo", (), frozenset(perms), vis, NOW)


def dl(scope, responsible="u1"):
    return Deadline("d1", scope, "T", "123", "TJ", "Cível", responsible, "open", "normal", date(2026, 1, 1),
                    date(2026, 1, 2), "business", 1, True, None, "u1", NOW, NOW)


def code(d):
    return None if d is None else d.code


def test_pessoal_so_o_dono_le_e_escreve():
    d = dl(Scope.personal("u1"))
    assert policy.can_read("u1", None, d)
    assert not policy.can_read("u2", None, d)
    admin = m("u2", ADMIN_PERMISSIONS, "all")
    assert not policy.can_read("u2", admin, d)             # admin de escritório não vê pessoal
    assert policy.check_write("u1", None, d, "deadline.edit") is None
    assert code(policy.check_write("u2", admin, d, "deadline.edit")) == "not_found"


def test_escritorio_exige_vinculo_read_e_visibilidade():
    d = dl(Scope.office("off"), responsible="u2")
    assert policy.can_read("u1", m("u1", {"deadline.read"}, "all"), d)
    assert not policy.can_read("u1", m("u1", {"deadline.read"}, "assigned"), d)
    assert policy.can_read("u2", m("u2", {"deadline.read"}, "assigned"), d)
    assert not policy.can_read("u1", m("u1", MEMBER_PERMISSIONS - {"deadline.read"}, "all"), d)
    assert not policy.can_read("u1", m("u1", {"deadline.read"}, "all", office="outro"), d)
    assert not policy.can_read("u1", None, d)


def test_gestao_nao_concede_acesso_a_prazos():
    d = dl(Scope.office("off"), responsible="u2")
    manager = m("u1", {"team.manage", "office.manage"}, "all")
    assert not policy.can_read("u1", manager, d)


def test_escrita_exige_leitura_e_permissao():
    d = dl(Scope.office("off"), responsible="u1")
    reader = m("u1", {"deadline.read"}, "assigned")
    assert code(policy.check_write("u1", reader, d, "deadline.edit")) == "forbidden"
    editor = m("u1", {"deadline.read", "deadline.edit"}, "assigned")
    assert policy.check_write("u1", editor, d, "deadline.edit") is None
    assert code(policy.check_write("u1", editor, d, "deadline.edit", "deadline.complete")) == "forbidden"
    invisible = dl(Scope.office("off"), responsible="u9")
    assert code(policy.check_write("u1", editor, invisible, "deadline.edit")) == "not_found"


def test_criacao_e_atribuicao():
    assert policy.check_create("u1", None, "personal") is None
    assert code(policy.check_create("u1", None, "office")) == "not_found"
    assert code(policy.check_create("u1", m("u1", {"deadline.create"}), "office")) == "forbidden"
    assert code(policy.check_create("u1", m("u1", {"deadline.read"}), "office")) == "forbidden"
    member = m("u1", {"deadline.read", "deadline.create"}, "assigned")
    assert policy.check_create("u1", member, "office") is None
    assert policy.check_assignment("u1", member, "office", "u1") is None
    assert code(policy.check_assignment("u1", member, "office", "u2")) == "delegation_not_allowed"
    assert policy.check_assignment("u1", m("u1", {"deadline.read"}, "all"), "office", "u2") is None
    assert code(policy.check_assignment("u1", None, "personal", "u2")) == "responsible_invalid"


def test_transferencia():
    own = dl(Scope.personal("u1"))
    t = m("u1", {"deadline.read", "deadline.transfer"})
    assert policy.check_transfer("u1", t, own, "off") is None
    assert code(policy.check_transfer("u1", t, own, "outro")) == "not_found"
    assert code(policy.check_transfer("u1", m("u1", {"deadline.transfer"}), own, "off")) == "forbidden"
    assert code(policy.check_transfer("u1", m("u1", {"deadline.read"}), own, "off")) == "forbidden"
    assert code(policy.check_transfer("u2", m("u2", {"deadline.read", "deadline.transfer"}), own, "off")) == "not_found"
    office = dl(Scope.office("off"))
    assert code(policy.check_transfer("u1", m("u1", {"deadline.read", "deadline.transfer"}, "all"), office, "off")) \
        == "not_transferable"
