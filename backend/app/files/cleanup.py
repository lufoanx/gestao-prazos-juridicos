"""Limpeza de blobs órfãos (fila `prazoai.file_cleanup`).

Entradas nascem de duas formas:
- `upload_pending`: reserva criada ANTES do upload; removida na MESMA transação que publica o
  arquivo na intimação. Se o processo cair ou a publicação falhar, a reserva vence e o blob (se
  chegou a existir) é apagado — nunca há metadado de arquivo sem blob, e blobs perdidos são recolhidos.
- `intimation_deleted`: gatilho do banco ao apagar uma intimação com arquivo (ex.: expurgo de
  descartadas após a retenção). O blob some depois da linha, nunca antes.

Cada lote: `FOR UPDATE SKIP LOCKED`, apaga o blob (idempotente) e só então remove a entrada.
"""
from __future__ import annotations

from datetime import datetime

from sqlalchemy import Engine, text

from app.core.logging import get_logger
from app.files.storage import BlobStore, FileStorageUnavailable

logger = get_logger("prazoai.files")


def run_file_cleanup(engine: Engine, store: BlobStore, now: datetime, *, batch_size: int = 50,
                     max_batches: int = 10) -> int:
    removed = 0
    for _ in range(max_batches):
        with engine.begin() as conn:
            rows = conn.execute(text(
                "SELECT blob_key FROM prazoai.file_cleanup WHERE not_before <= :now "
                "ORDER BY not_before LIMIT :n FOR UPDATE SKIP LOCKED"), {"now": now, "n": batch_size}).all()
            if not rows:
                break
            done = []
            for (key,) in rows:
                try:
                    store.delete(key)
                except FileStorageUnavailable:
                    logger.warning("file_cleanup_storage_unavailable")
                    break
                done.append(key)
            if done:
                conn.execute(text("DELETE FROM prazoai.file_cleanup WHERE blob_key = ANY(:keys)"), {"keys": done})
            removed += len(done)
            if len(done) < len(rows):
                break
    if removed:
        logger.info("file_cleanup removed=%s", removed)
    return removed
