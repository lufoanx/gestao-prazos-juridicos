"""Etapa 5 — políticas puras de acesso a intimações (inclui a regra da Issue #5)."""
from dataclasses import replace
from datetime import date, datetime, timezone

from app.domain.deadlines import Scope
from app.domain.intimations import Draft, FileMeta, Intimation, Processing
from app.domain.org import MEMBER_PERMISSIONS, Membership
from app.policies import intimations as policy

NOW = datetime(2026, 11, 9, tzinfo=timezone.utc)


def m(uid, perms=MEMBER_PERMISSIONS, vis="assigned", office="off"):
    return Membership(uid, office, "Cargo", (), frozenset(perms), vis, NOW)


def it(status="awaiting_review", scope=None, created_by="autor", suggested=None, deadline_id=None):
    return Intimation("i1", scope or Scope.office("off"), FileMeta("a.pdf", 1, "application/pdf"), date(2026, 1, 1),
                      status, Processing(), Draft(), created_by, NOW, NOW, suggested, None, deadline_id)


def test_pessoal_somente_dono():
    i = it(scope=Scope.personal("u1"), created_by="u1")
    assert policy.can_read("u1", None, i, None)
    assert not policy.can_read("u2", m("u2", vis="all"), i, None)


def test_escritorio_exige_vinculo_e_read():
    i = it()
    assert policy.can_read("x", m("x", vis="all"), i, None)
    assert not policy.can_read("x", m("x", perms={"deadline.create"}, vis="all"), i, None)
    assert not policy.can_read("x", m("x", vis="all", office="outro"), i, None)
    assert not policy.can_read("x", None, i, None)


def test_autor_e_sugerido_antes_da_revisao():
    i = it(suggested="sug")
    assert policy.can_read("autor", m("autor"), i, None)
    assert policy.can_read("sug", m("sug"), i, None)
    assert not policy.can_read("outro", m("outro"), i, None)
    for status in ("processing", "failed"):
        assert policy.can_read("sug", m("sug"), replace(i, status=status), None)


def test_revisada_considera_responsavel_atual_do_prazo_e_nao_a_sugestao_antiga():
    i = it(status="reviewed", suggested="sug", deadline_id="d1")
    assert not policy.can_read("sug", m("sug"), i, "outro-responsavel")     # sugestão obsoleta
    assert policy.can_read("resp", m("resp"), i, "resp")                    # responsável atual
    assert policy.can_read("autor", m("autor"), i, "resp")                  # autoria mantém acesso
    assert not policy.can_read("resp", m("resp", office="outro"), i, "resp")


def test_descartada_so_autor_ou_all():
    i = it(status="discarded", suggested="sug")
    assert not policy.can_read("sug", m("sug"), i, None)
    assert policy.can_read("autor", m("autor"), i, None)
    assert policy.can_read("x", m("x", vis="all"), i, None)


def test_escrita_exige_create_e_autor_ou_all_para_descartar():
    i = it(suggested="sug")
    assert policy.check_write("sug", m("sug", perms={"deadline.read"}), i, None).code == "forbidden"
    assert policy.check_write("sug", m("sug"), i, None) is None
    assert policy.check_write("sug", m("sug"), i, None, owner_or_all=True).code == "forbidden"
    assert policy.check_write("autor", m("autor"), i, None, owner_or_all=True) is None
    assert policy.check_write("x", m("x", vis="all"), i, None, owner_or_all=True) is None
    assert policy.check_write("outro", m("outro"), i, None).code == "not_found"
    manager = m("g", perms={"team.manage", "office.manage"}, vis="all")
    assert policy.check_write("g", manager, i, None).code == "not_found"     # gestão não dá acesso
