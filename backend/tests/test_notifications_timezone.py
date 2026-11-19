"""Fuso das notificações (doc 24): o PostgreSQL entrega `timestamptz` no fuso da SESSÃO (`TimeZone`);
a API devolve o MESMO instante, sempre em UTC, qualquer que seja esse fuso.

O fuso é aplicado SÓ ao banco de teste descartável já autorizado (`ALTER DATABASE … SET timezone`,
nível de banco, nunca o servidor) e restaurado ao final; as conexões do pool são recriadas antes e
depois para que nenhuma sessão de outro teste herde o fuso.
"""
from __future__ import annotations

import json
import re
import threading
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

import pytest
from sqlalchemy import DateTime, Text, cast, func, select, text

import app.db.tables  # noqa: F401  (registra as tabelas no MetaData)
from app.db.metadata import metadata
from app.db.tables import notifications as notifications_table
from tests.deadline_utils import create
from tests.intimation_utils import notifications as inbox
from tests.intimation_utils import register, unread
from tests.org_utils import API, OrgClient, fast_hasher

UTC = timezone.utc
ZONES = ("UTC", "America/Sao_Paulo", "Pacific/Kiritimati")          # 0, −3 e +14 horas
T_SETUP = datetime(2026, 11, 9, 23, 55, tzinfo=UTC)
T_CREATE = datetime(2026, 11, 9, 23, 59, 59, 999999, tzinfo=UTC)    # Kiritimati: já é dia 10
T_READ = datetime(2026, 11, 10, 2, 30, 0, 123456, tzinfo=UTC)       # São Paulo: ainda é dia 9
T_READ_AGAIN = T_READ + timedelta(minutes=7)
T_READ_ALL = datetime(2026, 11, 10, 11, 0, 0, 1, tzinfo=UTC)        # Kiritimati: já é dia 11


def _converter():
    """Importado em cada teste: na base sem a correção, só estes testes falham (e pelo motivo certo)."""
    from app.db.tables._types import UtcInstant

    return UtcInstant


def z(dt: datetime) -> str:
    """Representação canônica esperada na API: UTC com sufixo Z (microssegundos preservados)."""
    return dt.isoformat().replace("+00:00", "Z")


class SetClock:
    """Relógio injetável posicionado em instantes exatos (com microssegundos)."""

    def __init__(self, start: datetime) -> None:
        self._now = start
        self._lock = threading.Lock()

    def now(self) -> datetime:
        with self._lock:
            return self._now

    def set(self, at: datetime) -> None:
        with self._lock:
            self._now = at


# ------------------------------------------------------------------------------ conversor (sem banco)
def test_conversor_preserva_instante_microssegundos_e_nulos():
    t = _converter()()
    sp = datetime(2026, 11, 9, 23, 30, 0, 123456, tzinfo=ZoneInfo("America/Sao_Paulo"))
    out = t.process_result_value(sp, None)
    assert out == sp and out.tzinfo is UTC and out.microsecond == 123456
    assert out == datetime(2026, 11, 10, 2, 30, 0, 123456, tzinfo=UTC)          # instante, não relógio
    kiri = datetime(2026, 11, 11, 1, 0, 0, 1, tzinfo=ZoneInfo("Pacific/Kiritimati"))
    assert t.process_result_value(kiri, None) == datetime(2026, 11, 10, 11, 0, 0, 1, tzinfo=UTC)
    assert t.process_result_value(None, None) is None


def test_conversor_recusa_valor_sem_fuso_em_vez_de_adivinhar():
    with pytest.raises(ValueError):
        _converter()().process_result_value(datetime(2026, 11, 9, 12, 0), None)


def test_toda_coluna_de_instante_usa_o_conversor():
    UtcInstant = _converter()
    stamps = [(t.name, c.name, type(c.type).__name__) for t in metadata.tables.values() for c in t.columns
              if isinstance(c.type, (DateTime, UtcInstant))]
    assert stamps and all(kind == "UtcInstant" for *_, kind in stamps), stamps
    assert all(c.type.impl.timezone for t in metadata.tables.values() for c in t.columns
               if isinstance(c.type, UtcInstant))                               # continua timestamptz


# ------------------------------------------------------------------------------ PostgreSQL real
_DB_TZ = text(
    "SELECT s FROM pg_db_role_setting r, unnest(r.setconfig) s "
    "WHERE r.setrole = 0 AND r.setdatabase = (SELECT oid FROM pg_database WHERE datname = current_database()) "
    "AND s ILIKE 'timezone=%'"
)


@pytest.fixture(params=ZONES)
def session_zone(request, pg_schema):
    """Fuso padrão do banco de TESTE (descartável, já autorizado) → restaurado ao final."""
    zone = request.param
    assert zone in ZONES                                     # literal fixo, nunca entrada externa
    engine = pg_schema
    with engine.connect() as c:
        db = c.execute(text("SELECT current_database()")).scalar_one()
        before = c.execute(_DB_TZ).scalar_one_or_none()
    assert db.startswith("prazoai_test")
    q = engine.dialect.identifier_preparer.quote(db)
    with engine.begin() as c:
        c.execute(text(f"ALTER DATABASE {q} SET timezone = '{zone}'"))
    engine.dispose()                                         # novas conexões já nascem no fuso
    try:
        yield zone
    finally:
        with engine.begin() as c:
            if before is None:
                c.execute(text(f"ALTER DATABASE {q} RESET timezone"))
            else:
                c.execute(text(f"ALTER DATABASE {q} SET timezone = '{before.split('=', 1)[1]}'"))
        engine.dispose()
        with engine.connect() as c:
            assert c.execute(_DB_TZ).scalar_one_or_none() == before


def _session_zone_of(o) -> str:
    with o.app.state.auth.engine.connect() as c:
        return c.execute(text("SHOW TimeZone")).scalar_one()


def _pg_text(dt: datetime, zone: str) -> str:
    """Como o PostgreSQL exibe o instante na sessão `zone` (prova de que o cenário está ativo)."""
    local = dt.astimezone(ZoneInfo(zone))
    off = int(local.utcoffset().total_seconds() // 3600)
    frac = f".{local.microsecond:06d}".rstrip("0") if local.microsecond else ""
    return f"{local:%Y-%m-%d %H:%M:%S}{frac}{'+' if off >= 0 else '-'}{abs(off):02d}"


def _post(o, person, path):
    return o.http.post(f"{API}{path}", headers=person.headers)


def _at(o, clock, when, *people):
    clock.set(when)
    for p in people:
        o.relogin(p)                                         # o relógio injetado expira tokens antigos


def _view(items):
    """Projeção comparável entre modos (IDs são aleatórios em cada execução)."""
    return sorted((i["summary"]["title"], i["kind"], i["resourceType"], i["summary"]["dueDate"],
                   i["createdAt"], i["readAt"]) for i in items)


def _scenario(o, clock) -> dict:
    """Leitura individual, repetição, marcar todas e isolamento entre usuários; devolve o transcrito."""
    clock.set(T_SETUP)
    ana, bia, caio = o.person("ana"), o.person("bia"), o.person("caio")
    oid = o.office(ana)
    o.join(ana, oid, bia)
    o.join(ana, oid, caio)
    _at(o, clock, T_CREATE, ana)
    for title in ("Prazo A", "Prazo B", "Prazo C"):
        create(o, ana, responsibleId=bia.id, title=title, dueDate="2026-11-20")
    create(o, ana, responsibleId=caio.id, title="Prazo do Caio", dueDate="2026-11-10")

    _at(o, clock, T_READ, bia, caio)
    items = inbox(o, bia, perPage=100).json()["items"]
    assert [(i["createdAt"], i["readAt"]) for i in items] == [(z(T_CREATE), None)] * 3
    assert {i["summary"]["dueDate"] for i in items} == {"2026-11-20"}           # data civil intacta
    nid = next(i["id"] for i in items if i["summary"]["title"] == "Prazo A")
    assert _post(o, caio, f"/notifications/{nid}/read").status_code == 404     # de terceiro: não existe
    first = _post(o, bia, f"/notifications/{nid}/read")
    assert first.status_code == 200
    assert (first.json()["createdAt"], first.json()["readAt"]) == (z(T_CREATE), z(T_READ))

    _at(o, clock, T_READ_AGAIN, bia)
    again = _post(o, bia, f"/notifications/{nid}/read")                         # idempotente: mesmo readAt
    assert again.status_code == 200 and again.json() == first.json()

    _at(o, clock, T_READ_ALL, ana, bia, caio)
    assert _post(o, caio, "/notifications/read-all?scope=office").json() == {"marked": 1}   # só as dele
    assert unread(o, bia) == {"unread": 2}
    assert _post(o, bia, "/notifications/read-all?scope=office").json() == {"marked": 2}
    assert _post(o, bia, "/notifications/read-all?scope=office").json() == {"marked": 0}
    assert unread(o, bia) == {"unread": 0}

    bia_items = inbox(o, bia, perPage=100).json()["items"]
    caio_items = inbox(o, caio, perPage=100).json()["items"]
    assert inbox(o, ana, perPage=100).json()["total"] == 0                      # sem autonotificação
    read_at = {i["summary"]["title"]: i["readAt"] for i in bia_items}
    assert read_at == {"Prazo A": z(T_READ), "Prazo B": z(T_READ_ALL), "Prazo C": z(T_READ_ALL)}
    assert [(i["summary"]["title"], i["readAt"]) for i in caio_items] == [("Prazo do Caio", z(T_READ_ALL))]
    assert "Prazo do Caio" not in json.dumps(bia_items) and "Prazo A" not in json.dumps(caio_items)
    single = {k: v for k, v in first.json().items() if k not in ("id", "resourceId")}
    return {"bia": _view(bia_items), "caio": _view(caio_items), "single": single}


def _pg_org(pg_app, clock, delivery):
    return OrgClient(pg_app(clock=clock, delivery=delivery, password_hasher=fast_hasher(),
                            AUTH_REGISTER_MAX_REQUESTS=1000))


def _memory_org(make_app, clock, delivery):
    return OrgClient(make_app(clock=clock, delivery=delivery, password_hasher=fast_hasher(),
                              STORAGE="memory", ENVIRONMENT="test", AUTH_REGISTER_MAX_REQUESTS=1000))


@pytest.mark.postgres
def test_notificacoes_em_utc_em_qualquer_fuso_da_sessao(session_zone, pg_app, pg_engine, make_app, delivery):
    clock = SetClock(T_SETUP)
    o = _pg_org(pg_app, clock, delivery)
    assert _session_zone_of(o) == session_zone                                  # o pool da app está no fuso
    pg = _scenario(o, clock)
    assert _session_zone_of(o) == session_zone                                  # conexões reutilizadas também

    # No banco: o instante gravado é exatamente o do relógio; só a EXIBIÇÃO da sessão muda de fuso.
    n = notifications_table.c
    with pg_engine.connect() as c:
        assert c.execute(text("SHOW TimeZone")).scalar_one() == session_zone
        rows = c.execute(select(n.read_at, cast(n.read_at, Text), cast(n.created_at, Text))
                         .order_by(n.read_at)).all()
        assert c.execute(select(func.count()).where(n.created_at == T_CREATE)).scalar_one() == 4
    assert [r[0] for r in rows] == [T_READ, T_READ_ALL, T_READ_ALL, T_READ_ALL]
    assert all(r[0].tzinfo is UTC for r in rows)
    assert [r[1] for r in rows] == [_pg_text(T_READ, session_zone)] + [_pg_text(T_READ_ALL, session_zone)] * 3
    assert {r[2] for r in rows} == {_pg_text(T_CREATE, session_zone)}

    # Mesmo transcrito do modo memória (que nunca passou pelo banco).
    mem_clock = SetClock(T_SETUP)
    assert _scenario(_memory_org(make_app, mem_clock, delivery), mem_clock) == pg


_OFFSET = re.compile(r'T\d{2}:\d{2}:\d{2}(?:\.\d+)?(Z|[+-]\d{2}:\d{2})"')


@pytest.mark.postgres
def test_demais_instantes_lidos_do_banco_tambem_saem_em_utc(session_zone, pg_app, delivery):
    """O conversor é compartilhado: as demais saídas que leem `timestamptz` não variam com o fuso."""
    clock = SetClock(T_CREATE)
    o = _pg_org(pg_app, clock, delivery)
    ana, bia = o.person("ana"), o.person("bia")
    oid = o.office(ana)
    o.join(ana, oid, bia)
    d = create(o, ana, responsibleId=bia.id)
    i = register(o, ana)
    _at(o, clock, T_READ, ana)
    inv = o.http.post(f"{API}/offices/{oid}/invitations", headers=ana.headers, json={"roleLabel": "Membro"})
    assert inv.status_code == 201
    reads = {path: o.http.get(f"{API}{path}", headers=ana.headers) for path in (
        "/users/me", "/auth/me", f"/deadlines/{d['id']}", f"/deadlines/{d['id']}/history",
        f"/intimations/{i['id']}", f"/intimations/{i['id']}/history", f"/offices/{oid}",
        f"/offices/{oid}/members", f"/offices/{oid}/invitations", "/memberships/me")}
    for path, r in reads.items():
        assert r.status_code == 200, path
        assert set(_OFFSET.findall(r.text)) == {"Z"}, (path, session_zone)
    got = reads[f"/deadlines/{d['id']}"].json()
    assert (got["createdAt"], got["updatedAt"]) == (d["createdAt"], d["updatedAt"]) == (z(T_CREATE),) * 2
    assert got["dueDate"] == d["dueDate"] and got["startDate"] == d["startDate"]   # datas civis intactas
    assert reads[f"/intimations/{i['id']}"].json()["createdAt"] == i["createdAt"] == z(T_CREATE)
    listed = {x["id"]: x for x in reads[f"/offices/{oid}/invitations"].json()}[inv.json()["id"]]
    assert (listed["createdAt"], listed["expiresAt"]) == (inv.json()["createdAt"], inv.json()["expiresAt"])
    assert listed["createdAt"] == z(T_READ)
