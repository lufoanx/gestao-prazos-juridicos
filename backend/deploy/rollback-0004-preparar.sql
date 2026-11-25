-- Rollback de EMERGÊNCIA 0004 → 0003 quando JÁ EXISTEM PDFs armazenados (doc 28, §10). Sem segredos.
--
-- Por quê: a versão anterior do código exige o esquema 0003 e o downgrade 0004 → 0003 é RECUSADO
-- enquanto houver intimação com PDF (removeria o único vínculo com os blobs). Este script guarda o
-- vínculo num esquema à parte (`prazoai_rollback`) e desliga os campos de arquivo nas intimações, o que
-- permite `alembic downgrade 0003`. Nenhum blob é apagado; nenhum dado de negócio é removido.
-- Durante o rollback os PDFs ficam INACESSÍVEIS pela aplicação (a versão 0003 não os conhece).
--
-- Execução (papel DONO, aplicação parada ou em manutenção, DEPOIS de backup do banco):
--   psql "<url do dono>" -v ON_ERROR_STOP=1 --single-transaction -f rollback-0004-preparar.sql
--   PRAZOAI_CONFIRM_MIGRATION_TARGET=<host>:<porta>/<banco> alembic downgrade 0003
-- Volta (com a versão nova): alembic upgrade head → rollback-0004-restaurar.sql.
-- Testado em tests/test_db_0004_files.py.

CREATE SCHEMA prazoai_rollback;              -- falha se já existir: um rollback anterior não foi restaurado
CREATE TABLE prazoai_rollback.intimation_files AS
    SELECT id AS intimation_id, file_name, file_size_bytes, file_blob_key, file_sha256, file_stored_at
      FROM prazoai.intimations
     WHERE file_storage = 'stored';
CREATE TABLE prazoai_rollback.file_cleanup AS
    SELECT blob_key, reason, not_before, created_at FROM prazoai.file_cleanup;
UPDATE prazoai.intimations
   SET file_storage = 'not_stored', file_blob_key = NULL, file_sha256 = NULL, file_stored_at = NULL
 WHERE file_storage = 'stored';
