-- Privilégios mínimos do PrazoAI no PostgreSQL (doc 27, §6). Sem segredos.
--
-- Papéis (troque os marcadores pelos nomes reais antes de executar):
--   __OWNER__  dono do banco e dos esquemas; usado SÓ para migrations (backend e BFF) e para este arquivo
--   __API__    backend em execução: DML no esquema `prazoai`; nada em `prazoai_bff`
--   __BFF__    BFF em execução: DML só em `prazoai_bff.sessions`; nada no esquema do domínio
--   __DB__     banco do ambiente
--
-- Ordem: (1) migrations do backend e (2) do BFF com __OWNER__; (3) este arquivo, também com __OWNER__.
-- Repetível. Tabelas criadas depois por __OWNER__ no esquema `prazoai` recebem os privilégios da API
-- automaticamente (ALTER DEFAULT PRIVILEGES); novas tabelas em `prazoai_bff` exigem GRANT explícito.
-- Testado por frontend/tests/integration/least-privilege-backend.test.mjs.

REVOKE ALL ON DATABASE __DB__ FROM PUBLIC;
GRANT CONNECT ON DATABASE __DB__ TO __API__, __BFF__;

REVOKE ALL ON SCHEMA prazoai FROM PUBLIC;
REVOKE ALL ON SCHEMA prazoai_bff FROM PUBLIC;

-- API (backend)
GRANT USAGE ON SCHEMA prazoai TO __API__;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA prazoai TO __API__;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA prazoai TO __API__;
ALTER DEFAULT PRIVILEGES FOR ROLE __OWNER__ IN SCHEMA prazoai
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO __API__;
ALTER DEFAULT PRIVILEGES FOR ROLE __OWNER__ IN SCHEMA prazoai
  GRANT USAGE, SELECT ON SEQUENCES TO __API__;

-- BFF (sessões)
GRANT USAGE ON SCHEMA prazoai_bff TO __BFF__;
GRANT SELECT, INSERT, UPDATE, DELETE ON prazoai_bff.sessions TO __BFF__;
GRANT SELECT ON prazoai_bff.schema_version TO __BFF__;

-- Separação explícita (sem efeito se nada foi concedido antes)
REVOKE ALL ON ALL TABLES IN SCHEMA prazoai_bff FROM __API__;
REVOKE ALL ON SCHEMA prazoai_bff FROM __API__;
REVOKE ALL ON ALL TABLES IN SCHEMA prazoai FROM __BFF__;
REVOKE ALL ON SCHEMA prazoai FROM __BFF__;
