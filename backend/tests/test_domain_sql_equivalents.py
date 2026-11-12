"""P4 — equivalentes SQL dos testes do domínio marcados `memory_only` (PostgreSQL real).

Cada teste aqui cobre, no PostgreSQL, o cenário de um teste em memória que dependia de injetar
estado direto no armazenamento ou de comparar identidade de objetos. Retenção (expurgo) não tem
equivalente nesta entrega: é da P5.
"""
from __future__ import annotations

import uuid
from datetime import date

import pytest
from sqlalchemy import text, update
from sqlalchemy.exc import IntegrityError

from app.db.tables import intimations, memberships
from app.domain.errors import ConsistencyError
from tests.conftest import FakeClock
from tests.intimation_utils import register
from tests.org_utils import API, OrgClient, fast_hasher

pytestmark = pytest.mark.postgres


@pytest.fixture
def o(pg_app):
    return OrgClient(pg_app(OFFICES_ENABLED="true", password_hasher=fast_hasher(), clock=FakeClock()))


def test_aprovacao_encontra_vinculo_em_outro_escritorio_e_cancela(o, pg_schema):
    ana, bia, zed = o.person("ana"), o.person("bia"), o.person("zed")
    oid, zid = o.office(ana), o.office(zed, "Outro")
    code = o.http.get(f"{API}/offices/{oid}/join-code", headers=ana.headers).json()["joinCode"]
    rid = o.http.post(f"{API}/join-requests", headers=bia.headers, json={"joinCode": code}).json()["id"]
    with pg_schema.begin() as conn:                   # vínculo criado "por outro caminho", direto no banco
        conn.execute(memberships.insert().values(
            user_id=uuid.UUID(bia.id), office_id=uuid.UUID(zid), role_label="Membro", practice_areas=[],
            permissions=["deadline.read"], visibility="assigned", joined_at=o.app.state.auth.clock.now()))
    assert o.store.requests[rid].status == "pending"
    r = o.http.post(f"{API}/offices/{oid}/join-requests/{rid}/approve", headers=ana.headers)
    assert r.status_code == 409 and r.json()["error"]["code"] == "already_in_office"
    assert o.store.requests[rid].status == "cancelled"
    assert o.membership(bia).office_id == zid


def test_retry_sem_processamento_disponivel_sql(o, pg_schema):
    ana = o.person("ana")
    o.office(ana)
    i = register(o, ana)
    with pg_schema.begin() as conn:                   # estado reservado ao processamento, direto no banco
        conn.execute(update(intimations).where(intimations.c.id == uuid.UUID(i["id"])).values(status="failed"))
    r = o.http.post(f"{API}/intimations/{i['id']}/retry", headers=ana.headers, json={"version": 1})
    assert r.status_code == 409 and r.json()["error"]["code"] == "processing_unavailable"


def test_projecao_nao_altera_o_evento_armazenado_sql(o):
    ana, bia = o.person("ana"), o.person("bia")
    oid = o.office(ana)
    o.join(ana, oid, bia)
    i = register(o, ana, suggestedResponsibleId=bia.id)
    stored_before = o.app.state.org.unit_of_work.intimation_store.events[i["id"]]
    assert o.http.get(f"{API}/intimations/{i['id']}/history", headers=bia.headers).status_code == 200
    assert o.app.state.org.unit_of_work.intimation_store.events[i["id"]] == stored_before   # banco intacto


def test_escritas_invalidas_diretas_recusadas_pelo_banco(o):
    """No PostgreSQL a constraint recusa ANTES (CHECK imediato) ou no COMMIT (FK diferida)."""
    ana, bia = o.person("ana"), o.person("bia")
    oid = o.office(ana)
    i = register(o, ana)
    uow, clock = o.app.state.org.unit_of_work, o.app.state.auth.clock
    from dataclasses import replace

    with pytest.raises(IntegrityError) as exc:        # revisada sem vínculo
        with uow.unit(clock) as tx:
            cur = tx.intimations.get(i["id"])
            tx.intimations.put(replace(cur, status="reviewed", closed_at=tx.now))
    assert exc.value.orig.diag.constraint_name == "ck_intimations_reviewed_iff_linked"
    with pytest.raises(ConsistencyError, match="responsável operacional|fk_intimations_suggested_active"):
        with uow.unit(clock) as tx:                   # sugerido sem vínculo com o escritório
            cur = tx.intimations.get(i["id"])
            tx.intimations.put(replace(cur, suggested_responsible_id=bia.id))
    assert o.app.state.org.unit_of_work.intimation_store.intimations[i["id"]].suggested_responsible_id is None
    assert oid


def test_rollback_restaura_exclusoes_da_caixa_sql(pg_app, pg_schema):
    o = OrgClient(pg_app(OFFICES_ENABLED="true", password_hasher=fast_hasher(), clock=FakeClock(),
                         NOTIFICATIONS_MAX_PER_RECIPIENT="10"))
    ana, bia = o.person("ana"), o.person("bia")
    oid = o.office(ana)
    o.join(ana, oid, bia)
    from tests.deadline_utils import create

    for _ in range(10):
        create(o, ana, responsibleId=bia.id)          # caixa de bia no limite (10)
    before = o.app.state.org.unit_of_work.notification_store.notifications
    uow = o.app.state.org.unit_of_work
    uow.fault = lambda name: (_ for _ in ()).throw(RuntimeError("falha")) if name == "unit:commit" else None
    try:
        from tests.deadline_utils import body

        r = o.http.post(f"{API}/deadlines", headers=ana.headers, json=body(responsibleId=bia.id))
    finally:
        uow.fault = None
    assert r.status_code == 500
    assert o.app.state.org.unit_of_work.notification_store.notifications == before   # exclusão desfeita
    with pg_schema.connect() as conn:
        assert conn.execute(text("SELECT count(*) FROM prazoai.deadlines")).scalar_one() == 10
    _ = date
