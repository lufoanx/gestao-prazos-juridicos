"""P1 — fundação da persistência com PostgreSQL REAL (TEST_DATABASE_URL autorizada).

Conexão, timeouts efetivos, encerramento do engine e ciclo da revisão inicial do Alembic.
"""
from __future__ import annotations

import threading
import time
from pathlib import Path

import pytest
from alembic import command
from alembic.config import Config
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError, OperationalError

from app.db.config import SCHEMA
from app.db.engine import create_db_engine
from tests.pg_support import MARKER_TABLE

pytestmark = pytest.mark.postgres
BACKEND = Path(__file__).resolve().parents[1]


def test_conexao_versao_e_parametros_da_sessao(pg_clean, pg_config):
    with pg_clean.connect() as conn:
        assert conn.execute(text("SHOW server_version_num")).scalar_one() >= "160000"
        setting = "SELECT setting::int FROM pg_settings WHERE name = :n"
        lock_ms = conn.execute(text(setting), {"n": "lock_timeout"}).scalar_one()
        stmt_ms = conn.execute(text(setting), {"n": "statement_timeout"}).scalar_one()
        assert (lock_ms, stmt_ms) == (pg_config.lock_timeout_ms, pg_config.statement_timeout_ms)
        assert conn.execute(text("SHOW search_path")).scalar_one() == SCHEMA
        assert conn.execute(text("SELECT current_setting('application_name')")).scalar_one() == "prazoai-tests"
        assert conn.execute(text(f'SELECT count(*) FROM "{SCHEMA}"."{MARKER_TABLE}"')).scalar_one() == 1


def test_lock_timeout_interrompe_espera_por_bloqueio(pg_config):
    from dataclasses import replace

    engine = create_db_engine(replace(pg_config, lock_timeout_ms=300, statement_timeout_ms=5_000))
    try:
        with engine.connect() as holder, engine.connect() as waiter:
            holder.execute(text("SELECT pg_advisory_lock(424242)"))
            start = time.monotonic()
            with pytest.raises(OperationalError) as exc:
                waiter.execute(text("SELECT pg_advisory_lock(424242)"))
            elapsed = time.monotonic() - start
            assert getattr(exc.value.orig, "sqlstate", None) == "55P03"        # lock_not_available
            assert 0.2 <= elapsed < 3
            waiter.rollback()
            holder.execute(text("SELECT pg_advisory_unlock(424242)"))
    finally:
        engine.dispose()


def test_statement_timeout_interrompe_consulta_lenta(pg_config):
    from dataclasses import replace

    engine = create_db_engine(replace(pg_config, lock_timeout_ms=200, statement_timeout_ms=1_000))
    try:
        with engine.connect() as conn:
            start = time.monotonic()
            with pytest.raises(DBAPIError) as exc:
                conn.execute(text("SELECT pg_sleep(5)"))
            assert getattr(exc.value.orig, "sqlstate", None) == "57014"        # query_canceled
            assert time.monotonic() - start < 4
    finally:
        engine.dispose()


def test_dispose_encerra_todas_as_conexoes_do_pool(pg_config, pg_clean):
    engine = create_db_engine(pg_config, application_name="prazoai-dispose-test")
    conns = [engine.connect() for _ in range(3)]
    for c in conns:
        c.execute(text("SELECT 1"))
        c.close()                                                    # devolvidas ao pool (continuam abertas)

    def count() -> int:
        with pg_clean.connect() as obs:
            return obs.execute(text(
                "SELECT count(*) FROM pg_stat_activity WHERE application_name = 'prazoai-dispose-test'"
            )).scalar_one()

    assert count() == 3
    engine.dispose()
    deadline = time.monotonic() + 5
    while count() and time.monotonic() < deadline:
        time.sleep(0.1)
    assert count() == 0


def test_connect_timeout_para_servidor_que_nao_responde(pg_config):
    import socket
    from dataclasses import replace

    srv = socket.socket()
    srv.bind(("127.0.0.1", 0))
    srv.listen(1)                                                     # aceita TCP mas nunca responde ao protocolo
    port = srv.getsockname()[1]
    stop = threading.Event()
    try:
        # O destino efetivo é o ConnectionTarget (host/porta explícitos ao driver), não só a URL.
        cfg = replace(pg_config, url=pg_config.url.set(host="127.0.0.1", port=port),
                      target=replace(pg_config.target, host="127.0.0.1", port=port), connect_timeout_seconds=1)
        engine = create_db_engine(cfg)
        start = time.monotonic()
        with pytest.raises(OperationalError):
            engine.connect()
        assert time.monotonic() - start < 5
        engine.dispose()
    finally:
        stop.set()
        srv.close()


def _alembic_cfg(conn) -> Config:
    cfg = Config(str(BACKEND / "alembic.ini"))
    cfg.attributes["connection"] = conn
    return cfg


def _state(engine):
    with engine.connect() as conn:
        tables = sorted(r[0] for r in conn.execute(text(
            "SELECT table_name FROM information_schema.tables WHERE table_schema = :s"), {"s": SCHEMA}))
        exists = conn.execute(
            text("SELECT to_regclass(:t) IS NOT NULL"), {"t": f"{SCHEMA}.alembic_version"}).scalar_one()
        rev = None
        if exists:
            rev = conn.execute(text(f'SELECT version_num FROM "{SCHEMA}".alembic_version')).scalar_one_or_none()
        public = conn.execute(text(
            "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public'")).scalar_one()
    return tables, rev, public


def _migrate(engine, target: str, direction: str = "upgrade") -> None:
    with engine.begin() as conn:
        getattr(command, direction)(_alembic_cfg(conn), target)


BASE_TABLES = ["alembic_version", MARKER_TABLE]


def _head_tables() -> list[str]:
    from app.db.tables import TABLE_NAMES

    return sorted([*BASE_TABLES, *TABLE_NAMES])


# P2: a revisão head passou de 0001 para 0002 (as 14 tabelas aprovadas). P4: head = 0003 (coluna
# interna `seq`, sem tabelas novas). As expectativas foram atualizadas para o novo head; os ciclos
# pedidos na P2 continuam, e o ciclo 0003 ↔ 0002 foi acrescentado. Marcador e objetos externos sobrevivem.
def test_alembic_upgrade_downgrade_upgrade_ate_head(pg_clean):
    _migrate(pg_clean, "base", "downgrade")                            # parte de um estado conhecido
    assert _state(pg_clean)[:2] == (BASE_TABLES, None)
    _migrate(pg_clean, "head")
    tables, rev, public = _state(pg_clean)
    assert rev == "0003"
    assert tables == _head_tables()
    assert public == 0                                                  # nada fora do esquema explícito
    _migrate(pg_clean, "base", "downgrade")
    assert _state(pg_clean)[:2] == (BASE_TABLES, None)                  # marcador preservado
    _migrate(pg_clean, "head")
    assert _state(pg_clean)[1] == "0003"


def test_banco_sem_historico_de_migrations_vai_ao_head(pg_clean):
    """'Banco vazio' do ponto de vista do projeto: só o marcador da fixture, sem tabela de versões."""
    from sqlalchemy import text as sql

    _migrate(pg_clean, "base", "downgrade")
    with pg_clean.begin() as conn:
        conn.execute(sql(f'DROP TABLE "{SCHEMA}".alembic_version RESTRICT'))   # objeto do próprio Alembic
    assert _state(pg_clean)[:2] == ([MARKER_TABLE], None)
    _migrate(pg_clean, "head")
    tables, rev, _ = _state(pg_clean)
    assert (tables, rev) == (_head_tables(), "0003")


def test_banco_em_0001_avanca_para_0002_e_volta(pg_clean):
    _migrate(pg_clean, "base", "downgrade")
    _migrate(pg_clean, "0001")
    assert _state(pg_clean)[:2] == (BASE_TABLES, "0001")
    _migrate(pg_clean, "0002")
    assert _state(pg_clean)[:2] == (_head_tables(), "0002")
    _migrate(pg_clean, "0001", "downgrade")                            # 0002 → 0001
    assert _state(pg_clean)[:2] == (BASE_TABLES, "0001")
    _migrate(pg_clean, "0002")                                          # 0001 → 0002
    assert _state(pg_clean)[1] == "0002"
    _migrate(pg_clean, "0003")                                          # 0002 → 0003 (P4)
    assert _state(pg_clean)[:2] == (_head_tables(), "0003")
    _migrate(pg_clean, "0002", "downgrade")                            # 0003 → 0002
    assert _state(pg_clean)[:2] == (_head_tables(), "0002")
    _migrate(pg_clean, "head")


def test_downgrade_preserva_objetos_externos_a_revisao(pg_clean):
    from sqlalchemy import text as sql

    _migrate(pg_clean, "head")
    with pg_clean.begin() as conn:
        conn.execute(sql(f'CREATE TABLE "{SCHEMA}".p2_externo (id int)'))
        conn.execute(sql(f'INSERT INTO "{SCHEMA}".p2_externo VALUES (1)'))
    try:
        _migrate(pg_clean, "base", "downgrade")
        tables, rev, _ = _state(pg_clean)
        assert rev is None
        assert tables == sorted([*BASE_TABLES, "p2_externo"])          # marcador e objeto externo intactos
        with pg_clean.connect() as conn:
            assert conn.execute(sql(f'SELECT count(*) FROM "{SCHEMA}".{MARKER_TABLE}')).scalar_one() == 1
            assert conn.execute(sql(f'SELECT count(*) FROM "{SCHEMA}".p2_externo')).scalar_one() == 1
            namespaces = sql("SELECT count(*) FROM pg_namespace WHERE nspname = :s")
            assert conn.execute(namespaces, {"s": SCHEMA}).scalar_one() == 1
    finally:
        with pg_clean.begin() as conn:
            conn.execute(sql(f'DROP TABLE "{SCHEMA}".p2_externo RESTRICT'))
        _migrate(pg_clean, "head")


def test_falha_em_migration_desfaz_tudo(pg_clean):
    _migrate(pg_clean, "base", "downgrade")
    with pytest.raises(RuntimeError):
        with pg_clean.begin() as conn:
            command.upgrade(_alembic_cfg(conn), "head")
            raise RuntimeError("falha simulada depois do upgrade, antes do commit")
    assert _state(pg_clean)[:2] == (BASE_TABLES, None)                  # nenhuma tabela nem versão ficaram
    _migrate(pg_clean, "head")


def test_verificacao_recusa_banco_com_tabelas_estranhas(pg_clean, pg_url):
    from tests.pg_support import UnauthorizedTestDatabase, normalize_target, verify_and_prepare

    with pg_clean.begin() as conn:
        conn.execute(text("CREATE SCHEMA IF NOT EXISTS p1_estranho"))
        conn.execute(text("CREATE TABLE p1_estranho.dados (id int)"))
    try:
        with pg_clean.connect() as conn, pytest.raises(UnauthorizedTestDatabase, match="fora do esquema"):
            verify_and_prepare(conn, normalize_target(pg_url))
    finally:
        with pg_clean.begin() as conn:
            conn.execute(text("DROP TABLE p1_estranho.dados"))
            conn.execute(text("DROP SCHEMA p1_estranho"))


def test_verificacao_recusa_banco_diferente_do_esperado(pg_clean, pg_url):
    from dataclasses import replace

    from tests.pg_support import UnauthorizedTestDatabase, normalize_target, verify_and_prepare

    with pg_clean.connect() as conn, pytest.raises(UnauthorizedTestDatabase, match="esperado"):
        verify_and_prepare(conn, replace(normalize_target(pg_url), database="prazoai_test_outro"))


def test_check_cli_mostra_destino_sem_credenciais(pg_url, monkeypatch, capsys):
    from app.core.config import Settings
    from app.db.__main__ import check

    raw = pg_url.render_as_string(hide_password=False)
    code = check(Settings(_env_file=None, DATABASE_URL=raw, ENVIRONMENT="test"))  # type: ignore[arg-type]
    out = capsys.readouterr()
    assert code == 0, out.err
    assert "servidor: PostgreSQL 16" in out.out
    assert "revisão do esquema:" in out.out
    if pg_url.password:
        assert pg_url.password not in out.out + out.err
    assert (pg_url.username or "@@") + ":" not in out.out


# ---------------------------------------------------------------- destino efetivo (auditoria da P1)
def test_variaveis_herdadas_nao_desviam_a_conexao(pg_target, pg_config, monkeypatch):
    """PGHOST/PGPORT/PGDATABASE fictícias não têm efeito: host/porta/banco são passados explicitamente."""
    from app.db.engine import create_db_engine
    from tests.pg_support import verify_effective_destination

    monkeypatch.setenv("PGHOST", "db.externo.invalid")
    monkeypatch.setenv("PGPORT", "1")
    monkeypatch.setenv("PGDATABASE", "prazoai")
    engine = create_db_engine(pg_config, application_name="prazoai-tests-env")
    try:
        with engine.connect() as conn:
            info = conn.connection.dbapi_connection.info
            assert (info.host, int(info.port), info.dbname) == (pg_target.host, pg_target.port, pg_target.database)
            verify_effective_destination(conn, pg_target)            # só leitura
            assert conn.execute(text("SELECT current_database()")).scalar_one() == pg_target.database
    finally:
        engine.dispose()


def test_verificacao_pos_conexao_detecta_destino_divergente(pg_clean, pg_target):
    from dataclasses import replace

    from tests.pg_support import UnauthorizedTestDatabase, verify_effective_destination

    with pg_clean.connect() as conn:
        for wrong in (replace(pg_target, port=pg_target.port + 1), replace(pg_target, database="prazoai_test_x"),
                      replace(pg_target, host="db.externo.invalid")):
            with pytest.raises(UnauthorizedTestDatabase):
                verify_effective_destination(conn, wrong)


def test_pghostaddr_recusada_mesmo_apontando_para_loopback(pg_url, monkeypatch):
    import os

    from tests.pg_support import UnauthorizedTestDatabase, open_test_engine

    created: list[object] = []
    monkeypatch.setenv("PGHOSTADDR", "127.0.0.1")
    with pytest.raises(UnauthorizedTestDatabase, match="PGHOSTADDR"):
        open_test_engine(test_raw=pg_url.render_as_string(hide_password=False), app_raw=None, environment="test",
                         ci=False, env=os.environ, engine_factory=lambda *a, **k: created.append(a))
    assert created == []
