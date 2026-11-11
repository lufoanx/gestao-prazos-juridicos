-- =====================================================================================
-- PrazoAI — CENÁRIOS REPRODUZÍVEIS do DDL proposto (projeto técnico; NÃO é migration nem teste
-- da aplicação). Cada cenário verifica a si mesmo: imprime "OK <n>" ou aborta com "FALHA <n>".
--
-- Como executar (num banco DESCARTÁVEL e vazio; nunca em banco de desenvolvimento ou produção):
--   createdb prazoai_ddl_scratch
--   psql -X -v ON_ERROR_STOP=1 -d prazoai_ddl_scratch -f 15a-ddl-proposto-postgresql.sql
--   psql -X -q -v ON_ERROR_STOP=1 -d prazoai_ddl_scratch -f 15b-cenarios-ddl-proposto.sql 2>&1 \
--     | sed 's/^psql:[^:]*:[0-9]*: //' | diff - 15c-cenarios-saida-esperada.txt   # sem diferenças = OK
--   dropdb prazoai_ddl_scratch
-- Resultado esperado: 22 linhas "NOTICE: OK <n> …" seguidas de "NOTICE: TODOS OS 22 CENÁRIOS OK".
--
-- FKs DIFERIDAS: dentro de um bloco DO não há COMMIT; `SET CONSTRAINTS ALL IMMEDIATE` força a
-- mesma verificação que o COMMIT faria, no ponto desejado do cenário.
-- =====================================================================================
\set ON_ERROR_STOP 1
\o /dev/null
SET client_min_messages = notice;

-- Guarda: só roda em banco vazio de dados (evita uso acidental num banco com conteúdo).
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM users) THEN RAISE EXCEPTION 'banco não está vazio: use um banco descartável'; END IF;
END $$;

-- Utilitário: executa um comando e exige falha com a constraint esperada.
CREATE FUNCTION pg_temp.expect_fail(n int, label text, cmd text, constraint_name text) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE got text;
BEGIN
  BEGIN
    EXECUTE cmd;
    SET CONSTRAINTS ALL IMMEDIATE;      -- verificação equivalente ao COMMIT para FKs diferidas
    RAISE EXCEPTION 'FALHA %: % (comando foi aceito)', n, label;
  EXCEPTION WHEN integrity_constraint_violation OR check_violation OR unique_violation OR foreign_key_violation THEN
    GET STACKED DIAGNOSTICS got = CONSTRAINT_NAME;
    IF got IS DISTINCT FROM constraint_name THEN
      RAISE EXCEPTION 'FALHA %: % (esperada %, obtida %)', n, label, constraint_name, got;
    END IF;
  END;
  SET CONSTRAINTS ALL DEFERRED;
  RAISE NOTICE 'OK % — % (recusado por %)', n, label, constraint_name;
END $$;

CREATE FUNCTION pg_temp.expect_ok(n int, label text, cmd text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE cmd;
  SET CONSTRAINTS ALL IMMEDIATE;
  SET CONSTRAINTS ALL DEFERRED;
  RAISE NOTICE 'OK % — % (aceito)', n, label;
END $$;

BEGIN;                                                 -- tudo, inclusive os dados-base, é desfeito no final
SET CONSTRAINTS ALL DEFERRED;
-- Dados-base
INSERT INTO users VALUES
  ('00000000-0000-0000-0000-00000000000a','Ana','ana@x.com','h',0,'2026-11-01T12:00Z'),
  ('00000000-0000-0000-0000-00000000000b','Bia','bia@x.com','h',0,'2026-11-01T12:00Z'),
  ('00000000-0000-0000-0000-00000000000c','Caio','caio@x.com','h',0,'2026-11-01T12:00Z');
INSERT INTO offices VALUES ('00000000-0000-0000-0000-0000000000f1','Escritório','00000000-0000-0000-0000-00000000000a','2026-11-01T12:00Z','ABCDEFGH23');
INSERT INTO memberships VALUES
  ('00000000-0000-0000-0000-00000000000a','00000000-0000-0000-0000-0000000000f1','Sócia','{}',
   ARRAY['deadline.read','deadline.create','deadline.edit','deadline.complete','deadline.transfer','team.manage','office.manage'],'all','2026-11-01T12:00Z'),
  ('00000000-0000-0000-0000-00000000000b','00000000-0000-0000-0000-0000000000f1','Associada','{}',ARRAY['deadline.read'],'assigned','2026-11-01T12:00Z');

SELECT pg_temp.expect_fail(1, 'e-mail duplicado',
  $q$INSERT INTO users VALUES (gen_random_uuid(),'X','ana@x.com','h',0,now())$q$, 'users_email_key');
SELECT pg_temp.expect_fail(2, 'e-mail com maiúsculas',
  $q$INSERT INTO users VALUES (gen_random_uuid(),'X','Outra@x.com','h',0,now())$q$, 'users_email_check');
SELECT pg_temp.expect_fail(3, 'segundo vínculo do mesmo usuário',
  $q$INSERT INTO memberships VALUES ('00000000-0000-0000-0000-00000000000b','00000000-0000-0000-0000-0000000000f1','X','{}','{}','all',now())$q$, 'memberships_pkey');
SELECT pg_temp.expect_fail(4, 'prazo aberto do escritório com responsável sem vínculo (verificado no COMMIT)',
  $q$INSERT INTO deadlines (id,scope_kind,office_id,title,case_number,court,practice_area,responsible_id,status,priority,start_date,due_date,counting_mode,duration,reviewed,created_by,created_at,updated_at,open_office_id)
     VALUES (gen_random_uuid(),'office','00000000-0000-0000-0000-0000000000f1','T','123','TJ','Cível','00000000-0000-0000-0000-00000000000c','open','normal','2026-11-01','2026-11-20','business',10,true,'00000000-0000-0000-0000-00000000000a',now(),now(),'00000000-0000-0000-0000-0000000000f1')$q$,
  'deadlines_active_responsible_fk');
SELECT pg_temp.expect_ok(5, 'prazo aberto para membro ativo (Bia)',
  $q$INSERT INTO deadlines (id,scope_kind,office_id,title,case_number,court,practice_area,responsible_id,status,priority,start_date,due_date,counting_mode,duration,reviewed,created_by,created_at,updated_at,open_office_id)
     VALUES ('00000000-0000-0000-0000-0000000000d1','office','00000000-0000-0000-0000-0000000000f1','T','123','TJ','Cível','00000000-0000-0000-0000-00000000000b','open','normal','2026-11-01','2026-11-20','business',10,true,'00000000-0000-0000-0000-00000000000a',now(),now(),'00000000-0000-0000-0000-0000000000f1')$q$);
SELECT pg_temp.expect_fail(6, 'remover vínculo com prazo aberto sem reatribuir (verificado no COMMIT)',
  $q$DELETE FROM memberships WHERE user_id='00000000-0000-0000-0000-00000000000b'$q$, 'deadlines_active_responsible_fk');
SELECT pg_temp.expect_fail(7, 'open_office_id incoerente com o status',
  $q$UPDATE deadlines SET status='completed' WHERE id='00000000-0000-0000-0000-0000000000d1'$q$, 'deadlines_check2');
SELECT pg_temp.expect_ok(8, 'reatribuir para Ana e remover a Bia na mesma transação',
  $q$WITH r AS (UPDATE deadlines SET responsible_id='00000000-0000-0000-0000-00000000000a', version=version+1 WHERE id='00000000-0000-0000-0000-0000000000d1' RETURNING 1)
     DELETE FROM memberships WHERE user_id='00000000-0000-0000-0000-00000000000b'$q$);
SELECT pg_temp.expect_fail(9, 'prazo pessoal com responsável diferente do dono',
  $q$INSERT INTO deadlines (id,scope_kind,owner_id,title,case_number,court,practice_area,responsible_id,status,priority,start_date,due_date,counting_mode,duration,reviewed,created_by,created_at,updated_at)
     VALUES (gen_random_uuid(),'personal','00000000-0000-0000-0000-00000000000c','T','123','TJ','Cível','00000000-0000-0000-0000-00000000000a','open','normal','2026-11-01','2026-11-20','business',10,true,'00000000-0000-0000-0000-00000000000c',now(),now())$q$,
  'deadlines_check3');
SELECT pg_temp.expect_fail(10, 'vencimento antes do início',
  $q$INSERT INTO deadlines (id,scope_kind,owner_id,title,case_number,court,practice_area,responsible_id,status,priority,start_date,due_date,counting_mode,duration,reviewed,created_by,created_at,updated_at)
     VALUES (gen_random_uuid(),'personal','00000000-0000-0000-0000-00000000000c','T','123','TJ','Cível','00000000-0000-0000-0000-00000000000c','open','normal','2026-11-20','2026-11-01','business',10,true,'00000000-0000-0000-0000-00000000000c',now(),now())$q$,
  'deadlines_check1');
SELECT pg_temp.expect_ok(11, 'prazo pessoal da Ana + intimação pessoal revisada vinculada',
  $q$WITH d AS (INSERT INTO deadlines (id,scope_kind,owner_id,title,case_number,court,practice_area,responsible_id,status,priority,start_date,due_date,counting_mode,duration,reviewed,created_by,created_at,updated_at)
       VALUES ('00000000-0000-0000-0000-0000000000d2','personal','00000000-0000-0000-0000-00000000000a','T','123','TJ','Cível','00000000-0000-0000-0000-00000000000a','open','normal','2026-11-01','2026-11-20','business',10,true,'00000000-0000-0000-0000-00000000000a',now(),now()) RETURNING id)
     INSERT INTO intimations (id,scope_kind,owner_id,file_name,file_size_bytes,file_content_type,received_at,status,deadline_id,created_by,created_at,updated_at,closed_at)
       SELECT '00000000-0000-0000-0000-0000000000e1','personal','00000000-0000-0000-0000-00000000000a','a.pdf',100,'application/pdf','2026-11-01','reviewed',id,'00000000-0000-0000-0000-00000000000a',now(),now(),now() FROM d$q$);
SELECT pg_temp.expect_fail(12, 'segunda intimação para o mesmo prazo',
  $q$INSERT INTO intimations (id,scope_kind,owner_id,file_name,file_size_bytes,file_content_type,received_at,status,deadline_id,created_by,created_at,updated_at,closed_at)
     VALUES (gen_random_uuid(),'personal','00000000-0000-0000-0000-00000000000a','b.pdf',100,'application/pdf','2026-11-01','reviewed','00000000-0000-0000-0000-0000000000d2','00000000-0000-0000-0000-00000000000a',now(),now(),now())$q$,
  'intimations_deadline_id_key');
SELECT pg_temp.expect_fail(13, 'intimação revisada sem vínculo',
  $q$INSERT INTO intimations (id,scope_kind,owner_id,file_name,file_size_bytes,file_content_type,received_at,status,created_by,created_at,updated_at,closed_at)
     VALUES (gen_random_uuid(),'personal','00000000-0000-0000-0000-00000000000a','c.pdf',100,'application/pdf','2026-11-01','reviewed','00000000-0000-0000-0000-00000000000a',now(),now(),now())$q$,
  'intimations_check1');
SELECT pg_temp.expect_fail(14, 'transferir só o prazo, deixando a intimação no ambiente antigo (verificado no COMMIT)',
  $q$UPDATE deadlines SET scope_kind='office', owner_id=NULL, office_id='00000000-0000-0000-0000-0000000000f1', open_office_id='00000000-0000-0000-0000-0000000000f1', version=version+1 WHERE id='00000000-0000-0000-0000-0000000000d2'$q$,
  'intimations_deadline_same_scope_fk');
SELECT pg_temp.expect_ok(15, 'transferir prazo e intimação juntos',
  $q$WITH d AS (UPDATE deadlines SET scope_kind='office', owner_id=NULL, office_id='00000000-0000-0000-0000-0000000000f1', open_office_id='00000000-0000-0000-0000-0000000000f1', version=version+1 WHERE id='00000000-0000-0000-0000-0000000000d2' RETURNING 1)
     UPDATE intimations SET scope_kind='office', owner_id=NULL, office_id='00000000-0000-0000-0000-0000000000f1', version=version+1 WHERE id='00000000-0000-0000-0000-0000000000e1'$q$);
SELECT pg_temp.expect_fail(16, 'pendência sugerida a quem não tem vínculo (verificado no COMMIT)',
  $q$INSERT INTO intimations (id,scope_kind,office_id,file_name,file_size_bytes,file_content_type,received_at,status,suggested_responsible_id,suggested_open_office_id,created_by,created_at,updated_at)
     VALUES (gen_random_uuid(),'office','00000000-0000-0000-0000-0000000000f1','d.pdf',100,'application/pdf','2026-11-01','awaiting_review','00000000-0000-0000-0000-00000000000c','00000000-0000-0000-0000-0000000000f1','00000000-0000-0000-0000-00000000000a',now(),now())$q$,
  'intimations_suggested_active_fk');
DO $$ DECLARE a int; b int; BEGIN                     -- 17: deduplicação
  INSERT INTO notifications (id,recipient_id,scope_kind,office_id,kind,deadline_id,event_id,created_at)
  VALUES (gen_random_uuid(),'00000000-0000-0000-0000-00000000000a','office','00000000-0000-0000-0000-0000000000f1','deadline_assigned','00000000-0000-0000-0000-0000000000d1','00000000-0000-0000-0000-0000000000a1',now())
  ON CONFLICT ON CONSTRAINT notifications_dedupe_key DO NOTHING;
  GET DIAGNOSTICS a = ROW_COUNT;
  INSERT INTO notifications (id,recipient_id,scope_kind,office_id,kind,deadline_id,event_id,created_at)
  VALUES (gen_random_uuid(),'00000000-0000-0000-0000-00000000000a','office','00000000-0000-0000-0000-0000000000f1','deadline_assigned','00000000-0000-0000-0000-0000000000d1','00000000-0000-0000-0000-0000000000a1',now())
  ON CONFLICT ON CONSTRAINT notifications_dedupe_key DO NOTHING;
  GET DIAGNOSTICS b = ROW_COUNT;
  IF a <> 1 OR b <> 0 THEN RAISE EXCEPTION 'FALHA 17: deduplicação (%/%)', a, b; END IF;
  RAISE NOTICE 'OK 17 — notificação duplicada com ON CONFLICT DO NOTHING (1 inserida, depois 0)';
END $$;
SELECT pg_temp.expect_ok(18, 'primeiro token de redefinição ativo',
  $q$INSERT INTO password_reset_tokens VALUES (repeat('a',64),'00000000-0000-0000-0000-00000000000a',now(),now()+interval '1 hour',NULL,NULL)$q$);
SELECT pg_temp.expect_fail(19, 'segundo token ativo para o mesmo usuário',
  $q$INSERT INTO password_reset_tokens VALUES (repeat('b',64),'00000000-0000-0000-0000-00000000000a',now(),now()+interval '1 hour',NULL,NULL)$q$,
  'password_reset_one_active_per_user');
SELECT pg_temp.expect_fail(20, 'permissão desconhecida',
  $q$UPDATE memberships SET permissions = ARRAY['deadline.read','superuser'] WHERE user_id='00000000-0000-0000-0000-00000000000a'$q$,
  'memberships_permissions_check');
DO $$ DECLARE n int; v int; BEGIN                     -- 21: versão otimista
  UPDATE deadlines SET title='Aba velha', version=version+1 WHERE id='00000000-0000-0000-0000-0000000000d1' AND version=1;
  GET DIAGNOSTICS n = ROW_COUNT;
  SELECT version INTO v FROM deadlines WHERE id='00000000-0000-0000-0000-0000000000d1';
  IF n <> 0 OR v <> 2 THEN RAISE EXCEPTION 'FALHA 21: versão otimista (linhas=%, versão=%)', n, v; END IF;
  RAISE NOTICE 'OK 21 — UPDATE com versão antiga afeta 0 linhas (versão atual 2 preservada)';
END $$;
DO $$ DECLARE first_id uuid; second_id uuid; BEGIN   -- 22: código de ingresso com ON CONFLICT (sem abortar a transação)
  INSERT INTO offices VALUES (gen_random_uuid(),'Outro','00000000-0000-0000-0000-00000000000c',now(),'ABCDEFGH23')
  ON CONFLICT (join_code) DO NOTHING RETURNING id INTO first_id;          -- colide: nenhuma linha, transação segue válida
  INSERT INTO offices VALUES (gen_random_uuid(),'Outro','00000000-0000-0000-0000-00000000000c',now(),'ZZZZZZZZ23')
  ON CONFLICT (join_code) DO NOTHING RETURNING id INTO second_id;         -- novo código: inserido
  IF first_id IS NOT NULL OR second_id IS NULL THEN RAISE EXCEPTION 'FALHA 22: nova tentativa de código'; END IF;
  RAISE NOTICE 'OK 22 — código de ingresso repetido: ON CONFLICT não aborta; a nova tentativa insere';
END $$;
ROLLBACK;                                              -- nada fica gravado pelos cenários
DO $$ BEGIN RAISE NOTICE 'TODOS OS 22 CENÁRIOS OK'; END $$;
