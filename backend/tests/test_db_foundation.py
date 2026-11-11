"""P1 — fundação da persistência: configuração, proteções da fixture e engine, SEM banco real."""
from __future__ import annotations

import logging
import subprocess
import sys
from pathlib import Path

import pytest
from pydantic import ValidationError
from sqlalchemy import Column, Integer, MetaData, Table

from app.core.config import Settings
from app.db.config import SCHEMA, DatabaseConfigError, database_config_from, parse_database_url, safe_target
from app.db.engine import connection_options, create_db_engine
from app.db.metadata import metadata
from tests.pg_support import (
    UnauthorizedTestDatabase,
    authorize_test_database,
    normalize_target,
    truncate_statement,
)

SECRET = "S3nh4-Sup3r-Secreta"
URL = f"postgresql+psycopg://prazoai:{SECRET}@localhost:5432/prazoai_test"
BACKEND = Path(__file__).resolve().parents[1]


def settings(**env: str) -> Settings:
    return Settings(_env_file=None, **env)  # type: ignore[arg-type]


# ---------------------------------------------------------------- configuração
def test_padrao_memory_sem_url():
    s = settings()
    assert s.storage == "memory"
    assert s.database_url is None


@pytest.mark.parametrize("value", ["postgres", "auth-postgres", "Postgres "])
def test_storage_futuro_recusado_explicitamente(value):
    with pytest.raises(ValidationError) as exc:
        settings(STORAGE=value)
    assert "ainda não está disponível" in str(exc.value)


def test_storage_desconhecido_recusado():
    with pytest.raises(ValidationError) as exc:
        settings(STORAGE="redis")
    assert "STORAGE inválido" in str(exc.value)


def test_auth_storage_antigo_aceito_so_memory():
    assert settings(AUTH_STORAGE="memory").auth_storage_explicit is True
    assert settings().auth_storage_explicit is False
    with pytest.raises(ValidationError):
        settings(AUTH_STORAGE="postgres")


@pytest.mark.parametrize("env", [
    {"DATABASE_POOL_SIZE": "0"}, {"DATABASE_POOL_SIZE": "51"}, {"DATABASE_MAX_OVERFLOW": "-1"},
    {"DATABASE_POOL_TIMEOUT_SECONDS": "0"}, {"DATABASE_CONNECT_TIMEOUT_SECONDS": "61"},
    {"DATABASE_LOCK_TIMEOUT_MS": "50"}, {"DATABASE_STATEMENT_TIMEOUT_MS": "999"},
])
def test_limites_de_pool_e_timeouts(env):
    with pytest.raises(ValidationError):
        settings(**env)


def test_statement_timeout_nao_pode_ser_menor_que_lock_timeout():
    with pytest.raises(ValidationError) as exc:
        settings(DATABASE_LOCK_TIMEOUT_MS="5000", DATABASE_STATEMENT_TIMEOUT_MS="4000", DATABASE_URL=URL)
    assert "DATABASE_STATEMENT_TIMEOUT_MS" in str(exc.value)
    assert SECRET not in str(exc.value)                       # a URL não vaza em erro de outro campo


def test_url_invalida_ou_driver_errado_sem_expor_credenciais():
    for raw in [
        f"mysql://u:{SECRET}@h/db", f"postgresql+asyncpg://u:{SECRET}@h/db", f"://{SECRET}",
        f"postgresql+psycopg://u:{SECRET}@localhost:5432/", f"postgresql+psycopg://u:{SECRET}@h/db?options=-c%20x=1",
    ]:
        with pytest.raises(DatabaseConfigError) as exc:
            parse_database_url(raw)
        assert SECRET not in str(exc.value)
        assert exc.value.__cause__ is None                   # não encadeia exceção com o valor recebido


def test_url_normalizada_e_descricao_segura():
    url = parse_database_url(f"postgresql://prazoai:{SECRET}@db.local:6543/prazoai")
    assert url.drivername == "postgresql+psycopg"
    assert safe_target(url) == "db.local:6543/prazoai"
    socket_url = parse_database_url("postgresql://u@/prazoai?host=/run/pg&port=6000")
    assert safe_target(socket_url) == "socket-local:6000/prazoai"
    cfg = database_config_from(settings(DATABASE_URL=f"postgresql://prazoai:{SECRET}@db.local:6543/prazoai"))
    assert SECRET not in repr(cfg) and "prazoai@" not in repr(cfg)
    assert SECRET not in repr(settings(DATABASE_URL=URL))      # SecretStr


def test_database_url_vazia_equivale_a_ausente():
    assert settings(DATABASE_URL="   ").database_url is None
    with pytest.raises(DatabaseConfigError, match="não definida"):
        database_config_from(settings())


# ---------------------------------------------------------------- modo memory não conecta
def test_modo_memory_com_database_url_nao_conecta_nem_importa_sqlalchemy(monkeypatch, caplog):
    script = (
        "import os, sys\n"
        f"os.environ['DATABASE_URL'] = {URL!r}\n"
        "from app.main import create_app\n"
        "create_app()\n"
        "print('sqlalchemy' in sys.modules, 'psycopg' in sys.modules, 'app.db' in sys.modules)\n"
    )
    out = subprocess.run([sys.executable, "-c", script], cwd=BACKEND, capture_output=True, text=True, timeout=60)
    assert out.returncode == 0, out.stderr[-500:]
    assert out.stdout.strip().endswith("False False False")    # nenhum driver/engine carregado
    assert "database_url_ignored" in out.stderr
    assert SECRET not in out.stdout + out.stderr


def test_aviso_de_auth_storage_antigo(make_app, caplog):
    with caplog.at_level(logging.WARNING):
        make_app(AUTH_STORAGE="memory")
    assert "auth_storage_deprecated" in caplog.text


# ---------------------------------------------------------------- engine
def test_engine_configura_timeouts_esquema_e_encerra(monkeypatch):
    cfg = database_config_from(settings(
        DATABASE_URL=URL, DATABASE_LOCK_TIMEOUT_MS="1500", DATABASE_STATEMENT_TIMEOUT_MS="3000",
        DATABASE_POOL_SIZE="3", DATABASE_CONNECT_TIMEOUT_SECONDS="2",
    ))
    assert connection_options(cfg) == f"-c lock_timeout=1500 -c statement_timeout=3000 -c search_path={SCHEMA}"
    engine = create_db_engine(cfg)                              # não conecta ao criar
    try:
        assert engine.pool.size() == 3
        assert engine.hide_parameters is True
        assert SECRET not in repr(engine)
    finally:
        engine.dispose()


# ---------------------------------------------------------------- proteções da fixture
def auth(test_raw, app_raw=None, environment="test", ci=False):
    return authorize_test_database(test_raw, app_raw, environment=environment, ci=ci)


def test_fixture_aceita_banco_local_autorizado():
    assert auth(URL).database == "prazoai_test"
    assert auth(URL.replace("prazoai_test", "prazoai_test_p1")).database == "prazoai_test_p1"


@pytest.mark.parametrize("app_url", [
    URL,
    "postgresql+psycopg://outro:x@127.0.0.1/prazoai_test",                 # mesmo destino, outro usuário/host local
    "postgresql://admin:y@[::1]:5432/prazoai_test?sslmode=disable",        # IPv6 de loopback + porta padrão explícita
    "postgresql+psycopg://u@/prazoai_test?host=/var/run/postgresql",        # socket local
    "postgresql+psycopg://outro:x@db.remoto/prazoai_test?host=localhost",   # host da query prevalece
])
def test_fixture_recusa_mesmo_destino_normalizado(app_url):
    with pytest.raises(UnauthorizedTestDatabase, match="MESMO destino"):
        auth(URL, app_url)


def test_fixture_considera_porta_e_host_da_query_string():
    test_url = "postgresql+psycopg://prazoai:x@localhost:55433/prazoai_test"
    with pytest.raises(UnauthorizedTestDatabase, match="MESMO destino"):
        auth(test_url, "postgresql+psycopg://outro:y@127.0.0.1/prazoai_test?port=55433")
    assert auth(test_url, "postgresql+psycopg://outro:y@127.0.0.1/prazoai_test?port=5432").database == "prazoai_test"
    with pytest.raises(UnauthorizedTestDatabase, match="Host não autorizado"):
        auth("postgresql+psycopg://prazoai:x@localhost/prazoai_test?host=db.empresa.com")


@pytest.mark.parametrize("query", ["service=prod", "hostaddr=10.0.0.5", "dbname=prazoai", "host=a,b", "port=1,2"])
def test_parametros_que_redirecionam_a_conexao_sao_recusados(query):
    with pytest.raises(DatabaseConfigError):
        parse_database_url(f"postgresql+psycopg://u:{SECRET}@localhost/prazoai_test?{query}")


def test_fixture_aceita_destino_diferente_da_aplicacao():
    assert auth(URL, "postgresql+psycopg://u:p@localhost:5432/prazoai_dev").database == "prazoai_test"
    assert auth(URL, "postgresql+psycopg://u:p@localhost:5433/prazoai_test").database == "prazoai_test"   # outra porta


@pytest.mark.parametrize("raw, reason", [
    (URL.replace("prazoai_test", "prazoai"), "Nome de banco"),
    (URL.replace("prazoai_test", "prazoai_testx"), "Nome de banco"),
    (URL.replace("prazoai_test", "postgres"), "Nome de banco"),
    (URL.replace("localhost", "db.empresa.com"), "Host não autorizado"),
    (URL.replace("localhost", "postgres"), "Host não autorizado"),          # serviço do CI só com CI=true
])
def test_fixture_recusa_destinos_nao_autorizados(raw, reason):
    with pytest.raises(UnauthorizedTestDatabase, match=reason) as exc:
        auth(raw)
    assert SECRET not in str(exc.value)


def test_fixture_exige_environment_test_e_url_valida():
    with pytest.raises(UnauthorizedTestDatabase, match="ENVIRONMENT"):
        auth(URL, environment="development")
    with pytest.raises(UnauthorizedTestDatabase, match="não definida"):
        auth(None)
    with pytest.raises(UnauthorizedTestDatabase, match="DATABASE_URL inválida"):
        auth(URL, f"mysql://u:{SECRET}@h/x")


def test_fixture_aceita_servico_do_ci_somente_com_ci_true():
    assert auth(URL.replace("localhost", "postgres"), ci=True).host == "postgres"


def test_normalizacao_de_destino():
    assert normalize_target(parse_database_url("postgresql://u@LOCALHOST/prazoai_test")) == \
        normalize_target(parse_database_url("postgresql://v@127.0.0.1:5432/prazoai_test"))


def test_truncate_so_tabelas_do_projeto_qualificadas_e_sem_cascade():
    assert truncate_statement(metadata) is None                  # P1: nenhuma tabela de negócio
    md = MetaData(schema=SCHEMA)
    Table("a", md, Column("id", Integer, primary_key=True))
    Table("b", md, Column("id", Integer, primary_key=True))
    Table("fora", MetaData(schema="public"), Column("id", Integer, primary_key=True))
    stmt = truncate_statement(md)
    assert stmt == f'TRUNCATE TABLE "{SCHEMA}"."a", "{SCHEMA}"."b" RESTRICT'
    assert "CASCADE" not in stmt


def test_metadata_p1_sem_tabelas_e_no_esquema_explicito():
    assert metadata.schema == SCHEMA == "prazoai"
    assert list(metadata.tables) == []


def test_alembic_tem_uma_revisao_inicial_vazia():
    from alembic.config import Config
    from alembic.script import ScriptDirectory

    script = ScriptDirectory.from_config(Config(str(BACKEND / "alembic.ini")))
    revs = list(script.walk_revisions())
    assert [r.revision for r in revs] == ["0001"]
    assert revs[0].down_revision is None
    text_ = (BACKEND / "migrations" / "versions" / "0001_fundacao.py").read_text(encoding="utf-8")
    assert "op." not in text_                                    # nenhuma operação de esquema
    assert "sqlalchemy.url" not in (BACKEND / "alembic.ini").read_text(encoding="utf-8")   # sem URL no arquivo


def test_alembic_e_check_bloqueados_em_production(monkeypatch):
    env = {"ENVIRONMENT": "production", "DATABASE_URL": URL, "PATH": "/usr/bin:/bin", "AUTH_JWT_SECRET": "x" * 48}
    out = subprocess.run([sys.executable, "-m", "alembic", "upgrade", "head"], cwd=BACKEND, env=env,
                         capture_output=True, text=True, timeout=60)
    assert out.returncode != 0 and "bloqueadas em ENVIRONMENT=production" in out.stderr
    out = subprocess.run([sys.executable, "-m", "app.db", "check"], cwd=BACKEND, env=env,
                         capture_output=True, text=True, timeout=60)
    assert out.returncode == 2 and "não liberada" in out.stderr
    assert SECRET not in out.stdout + out.stderr
