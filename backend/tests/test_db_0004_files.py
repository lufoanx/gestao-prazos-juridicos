"""Migration 0004 (PDF das intimações) e procedimento de rollback, com PostgreSQL DESCARTÁVEL (doc 28, §10).

- 0003 → 0004 preserva os dados existentes (as intimações antigas ficam `not_stored`).
- Downgrade 0004 → 0003 é RECUSADO com PDF armazenado (nada muda).
- Rollback de emergência: `deploy/rollback-0004-preparar.sql` → downgrade 0003 (esquema exigido pela
  versão anterior) → operação na versão anterior (inclui expurgo sem gatilho) → upgrade head →
  `deploy/rollback-0004-restaurar.sql`: vínculos religados, blob da intimação apagada enfileirado,
  reservas preservadas; com Azurite, o PDF religado é baixado com os mesmos bytes.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
from alembic import command
from sqlalchemy import text

from tests.conftest import alembic_config_for

pytestmark = pytest.mark.postgres
BACKEND = Path(__file__).resolve().parents[1]
T0 = datetime(2026, 11, 20, 12, 0, tzinfo=timezone.utc)
COLS_0003 = ("id", "scope_kind", "owner_id", "file_name", "file_size_bytes", "file_content_type", "file_storage",
             "received_at", "status", "draft_title", "created_by", "created_at", "updated_at", "version")


def _migrate(engine, target, direction="upgrade"):
    with engine.begin() as conn:
        getattr(command, direction)(alembic_config_for(conn), target)


def _revision(engine):
    with engine.connect() as c:
        return c.execute(text("SELECT version_num FROM prazoai.alembic_version")).scalar_one()


def _user(conn):
    u = uuid.uuid4()
    conn.execute(text("INSERT INTO prazoai.users (id, name, email, password_hash, created_at) "
                      "VALUES (:u, 'Ana', :e, 'h', :t)"), {"u": u, "e": f"a-{u.hex[:8]}@exemplo.com", "t": T0})
    return u


def _intimation(conn, owner, *, title="Rascunho antigo", status="awaiting_review", stored_key=None):
    i = uuid.uuid4()
    conn.execute(text(
        "INSERT INTO prazoai.intimations (id, scope_kind, owner_id, file_name, file_size_bytes, file_content_type, "
        "received_at, status, draft_title, created_by, created_at, updated_at, version, closed_at) "
        "VALUES (:i, 'personal', :u, 'intimacao.pdf', 2048, 'application/pdf', '2026-11-20', :s, :title, :u, :t, :t, 3,"
        " CASE WHEN :s = 'discarded' THEN CAST(:t AS timestamptz) END)"),
        {"i": i, "u": owner, "s": status, "title": title, "t": T0})
    if stored_key:
        conn.execute(text("UPDATE prazoai.intimations SET file_storage = 'stored', file_blob_key = :k, "
                          "file_sha256 = :h, file_stored_at = :t WHERE id = :i"),
                     {"k": stored_key, "h": "a" * 64, "t": T0, "i": i})
    return i


def _rows(conn, ids):
    cols = ", ".join(COLS_0003)
    return {r.id: tuple(r) for r in conn.execute(text(f"SELECT {cols} FROM prazoai.intimations WHERE id = ANY(:ids)"),
                                                  {"ids": list(ids)})}


def _key():
    return f"intimations/{uuid.uuid4().hex}.pdf"


def _run_sql(engine, name):
    sql = (BACKEND / "deploy" / name).read_text(encoding="utf-8")
    with engine.begin() as conn:                  # equivalente a psql --single-transaction
        conn.connection.dbapi_connection.cursor().execute(sql)          # sem parâmetros, como o psql


def test_upgrade_0003_para_0004_preserva_os_dados(pg_clean):
    try:
        _migrate(pg_clean, "0003", "downgrade")
        assert _revision(pg_clean) == "0003"
        with pg_clean.begin() as conn:
            u = _user(conn)
            ids = [_intimation(conn, u), _intimation(conn, u, title="Outra", status="discarded")]
            before = _rows(conn, ids)
        _migrate(pg_clean, "0004")
        with pg_clean.begin() as conn:
            assert _rows(conn, ids) == before                                   # nenhum dado alterado
            new = conn.execute(text("SELECT count(*) FROM prazoai.intimations WHERE id = ANY(:ids) AND "
                                    "file_blob_key IS NULL AND file_sha256 IS NULL AND file_stored_at IS NULL "
                                    "AND file_storage = 'not_stored'"), {"ids": ids}).scalar_one()
            assert new == 2
            assert conn.execute(text("SELECT count(*) FROM prazoai.file_cleanup")).scalar_one() == 0
            assert conn.execute(text("SELECT count(*) FROM pg_trigger WHERE tgname = 'trg_intimations_file_cleanup'"))\
                .scalar_one() == 1
            # o gatilho enfileira o blob quando uma intimação com PDF é apagada (mesma transação)
            k = _key()
            i = _intimation(conn, u, stored_key=k)
            conn.execute(text("DELETE FROM prazoai.intimations WHERE id = :i"), {"i": i})
            row = conn.execute(text("SELECT reason FROM prazoai.file_cleanup WHERE blob_key = :k"), {"k": k}).one()
            assert row.reason == "intimation_deleted"
    finally:
        _migrate(pg_clean, "head")


def test_downgrade_recusado_com_pdf_e_rollback_preparado_e_restaurado(pg_clean):
    try:
        _migrate(pg_clean, "head")
        with pg_clean.begin() as conn:
            u = _user(conn)
            k_kept, k_purged, k_pending = _key(), _key(), _key()
            kept = _intimation(conn, u, title="Mantida", stored_key=k_kept)
            purged = _intimation(conn, u, title="Descartada", status="discarded", stored_key=k_purged)
            plain = _intimation(conn, u, title="Sem PDF")
            conn.execute(text("INSERT INTO prazoai.file_cleanup (blob_key, reason, not_before) "
                              "VALUES (:k, 'upload_pending', :t)"), {"k": k_pending, "t": T0 + timedelta(hours=1)})
            before = _rows(conn, [kept, plain])
        # 1) downgrade direto: recusado, nada muda
        with pytest.raises(Exception, match="downgrade recusado"):
            _migrate(pg_clean, "0003", "downgrade")
        assert _revision(pg_clean) == "0004"
        # 2) preparar → downgrade aceito (esquema da versão anterior)
        _run_sql(pg_clean, "rollback-0004-preparar.sql")
        with pytest.raises(Exception):                                          # não roda duas vezes
            _run_sql(pg_clean, "rollback-0004-preparar.sql")
        _migrate(pg_clean, "0003", "downgrade")
        assert _revision(pg_clean) == "0003"
        with pg_clean.begin() as conn:
            assert {k for k in _rows(conn, [kept, plain])} == {kept, plain}
            saved = conn.execute(text("SELECT count(*) FROM prazoai_rollback.intimation_files")).scalar_one()
            assert saved == 2
            # 3) versão anterior em operação: expurgo da descartada (0003 não tem gatilho)
            conn.execute(text("DELETE FROM prazoai.intimations WHERE id = :i"), {"i": purged})
        # 4) volta: upgrade → restaurar
        _migrate(pg_clean, "head")
        _run_sql(pg_clean, "rollback-0004-restaurar.sql")
        with pg_clean.begin() as conn:
            r = conn.execute(text("SELECT file_storage, file_blob_key, file_sha256 FROM prazoai.intimations "
                                  "WHERE id = :i"), {"i": kept}).one()
            assert (r.file_storage, r.file_blob_key, r.file_sha256) == ("stored", k_kept, "a" * 64)
            assert _rows(conn, [kept, plain]) == before                         # demais dados intactos
            queue = dict(conn.execute(text("SELECT blob_key, reason FROM prazoai.file_cleanup")).all())
            assert queue == {k_purged: "intimation_deleted", k_pending: "upload_pending"}
            assert conn.execute(text("SELECT to_regnamespace('prazoai_rollback') IS NULL")).scalar_one() is True
    finally:
        with pg_clean.begin() as conn:
            conn.execute(text("DROP SCHEMA IF EXISTS prazoai_rollback CASCADE"))
        _migrate(pg_clean, "head")


def test_restauracao_falha_sem_destino_para_algum_arquivo(pg_clean):
    """Se um arquivo guardado não puder ser religado nem enfileirado, a restauração falha inteira."""
    try:
        _migrate(pg_clean, "head")
        with pg_clean.begin() as conn:
            u = _user(conn)
            k = _key()
            i = _intimation(conn, u, stored_key=k)
        _run_sql(pg_clean, "rollback-0004-preparar.sql")
        _migrate(pg_clean, "0003", "downgrade")
        _migrate(pg_clean, "head")
        with pg_clean.begin() as conn:                     # alguém ocupou a intimação com outro arquivo
            conn.execute(text("UPDATE prazoai.intimations SET file_storage = 'stored', file_blob_key = :k, "
                              "file_sha256 = :h, file_stored_at = :t WHERE id = :i"),
                         {"k": _key(), "h": "b" * 64, "t": T0, "i": i})
        with pytest.raises(Exception, match="restauração incompleta"):
            _run_sql(pg_clean, "rollback-0004-restaurar.sql")
        with pg_clean.connect() as conn:                   # nada aplicado: o esquema de rollback continua
            assert conn.execute(text("SELECT to_regnamespace('prazoai_rollback') IS NOT NULL")).scalar_one() is True
    finally:
        with pg_clean.begin() as conn:
            conn.execute(text("DROP SCHEMA IF EXISTS prazoai_rollback CASCADE"))
        _migrate(pg_clean, "head")
