"""P4 — migration 0003 (`seq`, ordem interna de inserção) com PostgreSQL real.

`seq` ordena os registros de UM recurso de forma determinística. Não é horário, não é contador
sem lacunas e não é ordem global de commits.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone

import pytest
from alembic import command
from sqlalchemy import text

from tests.conftest import alembic_config_for

pytestmark = pytest.mark.postgres
T0 = datetime(2026, 11, 1, 12, 0, tzinfo=timezone.utc)


def _seed_rows(conn) -> dict:
    """Usuário, escritório pessoal e prazo pessoal + 3 eventos de histórico com o MESMO instante."""
    u, d = uuid.uuid4(), uuid.uuid4()
    conn.execute(text("INSERT INTO prazoai.users (id, name, email, password_hash, created_at) "
                      "VALUES (:u, 'Ana', :e, 'h', :t)"), {"u": u, "e": f"a-{u.hex[:6]}@x.com", "t": T0})
    conn.execute(text(
        "INSERT INTO prazoai.deadlines (id, scope_kind, owner_id, title, case_number, court, practice_area, "
        "responsible_id, status, priority, start_date, due_date, counting_mode, duration, reviewed, created_by, "
        "created_at, updated_at) VALUES (:d, 'personal', :u, 'T', 'N', 'C', 'A', :u, 'open', 'normal', "
        "'2026-11-01', '2026-11-20', 'business', 10, true, :u, :t, :t)"), {"d": d, "u": u, "t": T0})
    events = sorted([uuid.uuid4() for _ in range(3)], key=str)
    for e in events:
        conn.execute(text("INSERT INTO prazoai.deadline_history (id, deadline_id, actor_id, action, at) "
                          "VALUES (:e, :d, :u, 'updated', :t)"), {"e": e, "d": d, "u": u, "t": T0})
        conn.execute(text("INSERT INTO prazoai.deadline_comments (id, deadline_id, author_id, text, created_at) "
                          "VALUES (:e, :d, :u, 'c', :t)"), {"e": e, "d": d, "u": u, "t": T0})
    return {"user": u, "deadline": d, "events": events}


def _seq_of(conn, table: str, column: str, resource) -> list:
    stmt = text(f"SELECT id, seq FROM prazoai.{table} WHERE {column} = :r ORDER BY seq")
    return [tuple(r) for r in conn.execute(stmt, {"r": resource})]


def test_upgrade_com_dados_preenche_deterministicamente_e_continua_sem_colisao(pg_clean):
    try:
        with pg_clean.begin() as conn:
            command.downgrade(alembic_config_for(conn), "0002")
        with pg_clean.begin() as conn:
            seeded = _seed_rows(conn)
        with pg_clean.begin() as conn:
            command.upgrade(alembic_config_for(conn), "0003")
        with pg_clean.begin() as conn:
            hist = _seq_of(conn, "deadline_history", "deadline_id", seeded["deadline"])
            com = _seq_of(conn, "deadline_comments", "deadline_id", seeded["deadline"])
            # preenchimento por (instante, id): com instante idêntico, o desempate estável é o id
            assert [r[0] for r in hist] == seeded["events"] and [r[0] for r in com] == seeded["events"]
            assert [r[1] for r in hist] == [1, 2, 3]
            new = uuid.uuid4()
            conn.execute(text("INSERT INTO prazoai.deadline_history (id, deadline_id, actor_id, action, at) "
                              "VALUES (:e, :d, :u, 'updated', :t)"),
                         {"e": new, "d": seeded["deadline"], "u": seeded["user"], "t": T0})
            after = _seq_of(conn, "deadline_history", "deadline_id", seeded["deadline"])
            assert after[-1] == (new, 4)                                          # continua após o máximo
            with pytest.raises(Exception):                                         # GENERATED ALWAYS
                conn.execute(text("UPDATE prazoai.deadline_history SET seq = 99 WHERE id = :e"), {"e": new})
    finally:
        with pg_clean.begin() as conn:
            command.upgrade(alembic_config_for(conn), "head")


def test_downgrade_e_upgrade_preservam_os_registros(pg_clean):
    try:
        with pg_clean.begin() as conn:
            command.upgrade(alembic_config_for(conn), "head")
            seeded = _seed_rows(conn)
        with pg_clean.begin() as conn:
            command.downgrade(alembic_config_for(conn), "0002")
            cols = {r[0] for r in conn.execute(text(
                "SELECT table_name FROM information_schema.columns "
                "WHERE table_schema = 'prazoai' AND column_name = 'seq'"))}
            assert cols == set()                                                   # só a coluna sai
            n = conn.execute(text("SELECT count(*) FROM prazoai.deadline_history")).scalar_one()
            seqs = conn.execute(text("SELECT count(*) FROM pg_class WHERE relkind = 'S' "
                                     "AND relname LIKE '%seq_seq'")).scalar_one()
            assert (n, seqs) == (3, 0)
            assert conn.execute(text("SELECT count(*) FROM prazoai.prazoai_test_marker")).scalar_one() == 1
        with pg_clean.begin() as conn:
            command.upgrade(alembic_config_for(conn), "0003")
            assert len(_seq_of(conn, "deadline_history", "deadline_id", seeded["deadline"])) == 3
    finally:
        with pg_clean.begin() as conn:
            command.upgrade(alembic_config_for(conn), "head")


def test_identidade_cache_1_no_cycle_e_unicidade_por_recurso(pg_schema):
    with pg_schema.connect() as conn:
        rows = conn.execute(text(
            "SELECT c.relname, s.seqcache, s.seqcycle FROM pg_sequence s JOIN pg_class c ON c.oid = s.seqrelid "
            "JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'prazoai' ORDER BY 1")).all()
    assert [tuple(r) for r in rows] == [("deadline_comments_seq_seq", 1, False),
                                        ("deadline_history_seq_seq", 1, False),
                                        ("intimation_events_seq_seq", 1, False)]


def test_rollback_consome_valores_sem_quebrar_a_ordem(pg_schema):
    with pg_schema.begin() as conn:
        seeded = _seed_rows(conn)
    args = {"d": seeded["deadline"], "u": seeded["user"], "t": T0}
    with pg_schema.connect() as conn:
        tx = conn.begin()
        conn.execute(text("INSERT INTO prazoai.deadline_history (id, deadline_id, actor_id, action, at) "
                          "VALUES (gen_random_uuid(), :d, :u, 'updated', :t)"), args)
        tx.rollback()                                                          # valor consumido
    with pg_schema.begin() as conn:
        conn.execute(text("INSERT INTO prazoai.deadline_history (id, deadline_id, actor_id, action, at) "
                          "VALUES (gen_random_uuid(), :d, :u, 'updated', :t)"), args)
        seqs = [r[1] for r in _seq_of(conn, "deadline_history", "deadline_id", seeded["deadline"])]
    assert len(seqs) == 4 and seqs == sorted(seqs) and seqs[-1] > seqs[-2] + 1   # lacuna aceita
