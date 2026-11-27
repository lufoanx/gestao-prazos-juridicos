"""Arquivos PDF das intimações: metadados do armazenamento e fila de limpeza.

- `intimations`: `file_storage` passa a aceitar `stored`; novas colunas `file_blob_key` (chave gerada no
  servidor, única), `file_sha256` e `file_stored_at`; CHECK: `stored` ⇔ as três preenchidas.
  Os bytes ficam no Azure Blob Storage (container privado), nunca no banco.
- `file_cleanup`: fila de blobs a remover (reserva de upload não concluída ou intimação apagada).
- Gatilho `AFTER DELETE` em `intimations`: toda remoção de intimação com arquivo (ex.: expurgo de
  descartadas após a retenção) enfileira o blob na MESMA transação.

Downgrade: recusado se existir intimação com arquivo armazenado (removeria o único vínculo com os
blobs). Sem arquivos, remove gatilho, função, fila, colunas e restaura o CHECK anterior.

Revisão: 0004
Anterior: 0003
"""
from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0004"
down_revision: str | Sequence[str] | None = "0003"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

S = "prazoai"


def upgrade() -> None:
    op.drop_constraint(op.f("ck_intimations_file_not_stored"), "intimations", schema=S, type_="check")
    op.add_column("intimations", sa.Column("file_blob_key", sa.Text(), nullable=True), schema=S)
    op.add_column("intimations", sa.Column("file_sha256", sa.Text(), nullable=True), schema=S)
    op.add_column("intimations", sa.Column("file_stored_at", sa.DateTime(timezone=True), nullable=True), schema=S)
    op.create_check_constraint(op.f("ck_intimations_file_storage_valid"), "intimations",
                               "file_storage IN ('not_stored', 'stored')", schema=S)
    op.create_check_constraint(
        op.f("ck_intimations_file_stored_complete"), "intimations",
        "(file_storage = 'stored') = (file_blob_key IS NOT NULL AND file_sha256 IS NOT NULL "
        "AND file_stored_at IS NOT NULL)", schema=S)
    op.create_check_constraint(
        op.f("ck_intimations_file_blob_key_shape"), "intimations",
        "file_blob_key IS NULL OR file_blob_key ~ '^intimations/[0-9a-f]{32}[.]pdf$'", schema=S)
    op.create_check_constraint(op.f("ck_intimations_file_sha256_shape"), "intimations",
                               "file_sha256 IS NULL OR file_sha256 ~ '^[0-9a-f]{64}$'", schema=S)
    op.create_unique_constraint(op.f("uq_intimations_file_blob_key"), "intimations", ["file_blob_key"], schema=S)
    op.create_table(
        "file_cleanup",
        sa.Column("blob_key", sa.Text(), nullable=False),
        sa.Column("reason", sa.Text(), nullable=False),
        sa.Column("not_before", sa.DateTime(timezone=True), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.PrimaryKeyConstraint("blob_key", name=op.f("pk_file_cleanup")),
        sa.CheckConstraint("reason IN ('upload_pending', 'intimation_deleted')",
                           name=op.f("ck_file_cleanup_reason_valid")),
        sa.CheckConstraint("blob_key ~ '^intimations/[0-9a-f]{32}[.]pdf$'",
                           name=op.f("ck_file_cleanup_blob_key_shape")),
        schema=S,
    )
    op.create_index(op.f("ix_file_cleanup_not_before"), "file_cleanup", ["not_before"], schema=S)
    op.execute(f"""
        CREATE FUNCTION {S}.enqueue_intimation_file_cleanup() RETURNS trigger
        LANGUAGE plpgsql SET search_path = pg_catalog AS $$
        BEGIN
            INSERT INTO {S}.file_cleanup (blob_key, reason, not_before)
            VALUES (OLD.file_blob_key, 'intimation_deleted', now())
            ON CONFLICT (blob_key) DO UPDATE SET reason = 'intimation_deleted', not_before = now();
            RETURN OLD;
        END $$;
    """)
    op.execute(f"""
        CREATE TRIGGER trg_intimations_file_cleanup AFTER DELETE ON {S}.intimations
        FOR EACH ROW WHEN (OLD.file_blob_key IS NOT NULL)
        EXECUTE FUNCTION {S}.enqueue_intimation_file_cleanup();
    """)


def downgrade() -> None:
    op.execute(f"""
        DO $$ BEGIN
            IF EXISTS (SELECT 1 FROM {S}.intimations WHERE file_storage = 'stored') THEN
                RAISE EXCEPTION 'downgrade recusado: existem intimações com PDF armazenado';
            END IF;
        END $$;
    """)
    op.execute(f"DROP TRIGGER trg_intimations_file_cleanup ON {S}.intimations")
    op.execute(f"DROP FUNCTION {S}.enqueue_intimation_file_cleanup()")
    op.drop_index(op.f("ix_file_cleanup_not_before"), table_name="file_cleanup", schema=S)
    op.drop_table("file_cleanup", schema=S)
    op.drop_constraint(op.f("uq_intimations_file_blob_key"), "intimations", schema=S, type_="unique")
    for name in ("ck_intimations_file_sha256_shape", "ck_intimations_file_blob_key_shape",
                 "ck_intimations_file_stored_complete", "ck_intimations_file_storage_valid"):
        op.drop_constraint(op.f(name), "intimations", schema=S, type_="check")
    for col in ("file_stored_at", "file_sha256", "file_blob_key"):
        op.drop_column("intimations", col, schema=S)
    op.create_check_constraint(op.f("ck_intimations_file_not_stored"), "intimations",
                               "file_storage = 'not_stored'", schema=S)
