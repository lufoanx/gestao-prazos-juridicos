-- Volta do rollback de emergência (doc 28, §10): religa os PDFs guardados por rollback-0004-preparar.sql.
-- Pré-requisito: esquema já de volta à 0004 (`alembic upgrade head`) e aplicação nova ainda parada.
--   psql "<url do dono>" -v ON_ERROR_STOP=1 --single-transaction -f rollback-0004-restaurar.sql
-- Intimações apagadas durante o rollback (ex.: expurgo de descartadas pela versão 0003, sem gatilho):
-- seus blobs vão para a fila de limpeza. Falha (e nada muda) se algum arquivo ficar sem destino.

UPDATE prazoai.intimations i
   SET file_storage = 'stored', file_blob_key = r.file_blob_key, file_sha256 = r.file_sha256,
       file_stored_at = r.file_stored_at, file_name = r.file_name, file_size_bytes = r.file_size_bytes
  FROM prazoai_rollback.intimation_files r
 WHERE i.id = r.intimation_id AND i.file_storage = 'not_stored';

INSERT INTO prazoai.file_cleanup (blob_key, reason, not_before)
SELECT r.file_blob_key, 'intimation_deleted', now()
  FROM prazoai_rollback.intimation_files r
 WHERE NOT EXISTS (SELECT 1 FROM prazoai.intimations i WHERE i.id = r.intimation_id)
ON CONFLICT (blob_key) DO NOTHING;

INSERT INTO prazoai.file_cleanup (blob_key, reason, not_before, created_at)
SELECT blob_key, reason, not_before, created_at FROM prazoai_rollback.file_cleanup
ON CONFLICT (blob_key) DO NOTHING;

DO $$
DECLARE missing integer;
BEGIN
    SELECT count(*) INTO missing
      FROM prazoai_rollback.intimation_files r
     WHERE NOT EXISTS (SELECT 1 FROM prazoai.intimations i
                        WHERE i.id = r.intimation_id AND i.file_blob_key = r.file_blob_key)
       AND NOT EXISTS (SELECT 1 FROM prazoai.file_cleanup c WHERE c.blob_key = r.file_blob_key);
    IF missing > 0 THEN
        RAISE EXCEPTION 'restauração incompleta: % arquivo(s) sem vínculo nem limpeza agendada', missing;
    END IF;
END $$;

DROP SCHEMA prazoai_rollback CASCADE;
