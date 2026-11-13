"""Etapa 3 — retenção finita, tetos e colisão do código de ingresso."""
import pytest

import app.services.org_service as org_service
from app.repositories.org_memory import MemoryOrgStore
from tests.org_utils import API

DAY = 24 * 3600


@pytest.mark.memory_only(
    "retenção dentro das transações em memória; equivalente SQL (P5): "
    "test_maintenance_operation::test_sql_convites_e_solicitacoes_encerrados_removidos_apos_retencao e "
    "test_maintenance_postgres::test_convites_por_encerramento_ou_expiracao_na_fronteira"
)
def test_convites_encerrados_e_expirados_sao_removidos_apos_retencao(org, clock):
    o = org(ORG_CLOSED_RETENTION_SECONDS=DAY)
    ana, bia = o.person("ana"), o.person("bia")
    oid = o.office(ana)
    used = o.invite(ana, oid)
    o.http.post(f"{API}/invitations/accept", headers=bia.headers, json={"token": used})
    o.invite(ana, oid)                                     # ficará expirado
    assert len(o.store.invitations) == 2
    clock.advance(7 * DAY)                                 # o pendente expira agora
    o.relogin(ana)
    pending_ok = o.invite(ana, oid)                        # escrita dispara a limpeza
    assert len(o.store.invitations) == 2                   # aceito (>1 dia) removido; expirado ainda retido
    clock.advance(DAY)
    assert o.app.state.org.service._repo.purge(clock.now()) == 1
    assert len(o.store.invitations) == 1
    assert o.http.post(f"{API}/invitations/lookup", json={"token": pending_ok}).json()["state"] == "valid"
    assert all(v for v in o.store.invitations_by_office.values())


@pytest.mark.memory_only(
    "retenção dentro das transações em memória; equivalente SQL (P5): "
    "test_maintenance_operation::test_sql_convites_e_solicitacoes_encerrados_removidos_apos_retencao e "
    "test_maintenance_postgres::test_solicitacoes_decididas_apos_retencao"
)
def test_solicitacoes_encerradas_sao_removidas_e_pendentes_mantidas(org, clock):
    o = org(ORG_CLOSED_RETENTION_SECONDS=DAY)
    ana, bia, caio = o.person("ana"), o.person("bia"), o.person("caio")
    oid = o.office(ana)
    code = o.service.get_join_code(ana.id, oid)
    rb, _ = o.service.create_join_request(bia.id, code, "1.1.1.1")
    rc, _ = o.service.create_join_request(caio.id, code, "1.1.1.2")
    o.service.reject_request(ana.id, oid, rb.id)
    clock.advance(DAY)
    assert o.service._repo.purge(clock.now()) == 1
    assert set(o.store.requests) == {rc.id}
    assert bia.id not in o.store.requests_by_user


def test_retencao_invalida_e_rejeitada(make_app):
    for value in ("0", "3600", str(400 * DAY)):
        with pytest.raises(Exception):
            make_app(ORG_CLOSED_RETENTION_SECONDS=value)
    with pytest.raises(ValueError):
        MemoryOrgStore(closed_retention_seconds=0)


@pytest.mark.parametrize("var,value", [
    ("ORG_INVITE_TTL_SECONDS", "60"), ("ORG_MAX_PENDING_INVITES_PER_OFFICE", "0"),
    ("ORG_MAX_PENDING_REQUESTS_PER_USER", "51"), ("ORG_JOIN_REQUEST_MAX", "-1"),
])
def test_configuracoes_invalidas(make_app, var, value):
    with pytest.raises(Exception):
        make_app(**{var: value})


def test_ttl_do_convite_configuravel(org, clock):
    o = org(ORG_INVITE_TTL_SECONDS=3600)
    ana = o.person("ana")
    token = o.invite(ana, o.office(ana))
    clock.advance(3599)
    assert o.http.post(f"{API}/invitations/lookup", json={"token": token}).json()["state"] == "valid"
    clock.advance(1)
    assert o.http.post(f"{API}/invitations/lookup", json={"token": token}).json()["state"] == "expired"


def test_colisao_de_codigo_gera_outro(org, monkeypatch):
    o = org()
    ana, bia = o.person("ana"), o.person("bia")
    sequence = iter(["AAAAAAAAAA", "AAAAAAAAAA", "BBBBBBBBBB"])
    monkeypatch.setattr(org_service, "new_join_code", lambda: next(sequence))
    o.office(ana, "Um")
    o.office(bia, "Dois")
    assert set(o.store.office_by_code) == {"AAAAAAAAAA", "BBBBBBBBBB"}


def test_colisao_persistente_falha_sem_criar_nada(org, monkeypatch):
    o = org()
    ana, bia = o.person("ana"), o.person("bia")
    monkeypatch.setattr(org_service, "new_join_code", lambda: "CCCCCCCCCC")
    o.office(ana, "Um")
    r = o.http.post(f"{API}/offices", headers=bia.headers, json={"name": "Dois"})
    assert r.status_code == 503 and r.json()["error"]["code"] == "join_code_unavailable"
    assert len(o.store.offices) == 1 and o.membership(bia) is None


def test_limitadores_do_modulo_tem_memoria_limitada(org):
    o = org(AUTH_RATE_LIMIT_MAX_KEYS=10)
    limited = 0
    for i in range(50):   # 50 IPs distintos; acima do teto, compartilham o balde de transbordo
        try:
            o.service.lookup_invitation(f"token-inexistente-{i:04d}", f"10.0.{i // 250}.{i % 250}")
        except Exception as exc:
            assert getattr(exc, "status_code", None) == 429
            limited += 1
    assert o.service._invite_lookup_limiter.tracked_keys() <= 11
    assert limited == 50 - 10 - 30        # 10 chaves individuais + 30 eventos no transbordo
