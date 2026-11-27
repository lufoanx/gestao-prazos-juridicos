"""Homologação e produção (doc 27): validação explícita dos requisitos de implantação.

1. Sem banco: cada requisito ausente ou inseguro impede o startup, em staging E production, com
   mensagem que lista o problema sem exibir valores; a configuração completa (fictícia) passa.
2. Com PostgreSQL DESCARTÁVEL com TLS (PRAZOAI_TEST_HOSTED_DATABASE_URL, banco prazoai_test_*, host
   local): migrations pelo caminho hospedado (TLS + confirmação do destino), app real em staging e
   production: documentação interativa e OpenAPI indisponíveis, readiness, IP do cliente só pelo
   intermediário com segredo, limites por IP, persistência após reinício. Sem a variável, os casos
   com banco são PULADOS — ou FALHAM com PRAZOAI_REQUIRE_HOSTED_TESTS=1.
Nenhum valor real: domínios .exemplo/.invalid, segredos gerados por execução.
"""
from __future__ import annotations

import os
import re
import secrets
import subprocess
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.core.config import HostedConfigError, Settings, ensure_hosted_requirements, get_settings

BACKEND = Path(__file__).resolve().parents[1]
SMTP_PASSWORD = "senha-smtp-ficticia-" + secrets.token_hex(8)
JWT = secrets.token_urlsafe(48)
PROXY = secrets.token_urlsafe(48)
DB_PASSWORD = "senha-db-ficticia-" + secrets.token_hex(8)
AZ_KEY = "chave-azure-ficticia-" + secrets.token_hex(8)


def hosted_env(environment: str = "production", **over: str | None) -> dict[str, str]:
    env = {
        "ENVIRONMENT": environment,
        "STORAGE": "postgres",
        "DATABASE_URL": f"postgresql+psycopg://app:{DB_PASSWORD}@db.exemplo.invalid:5432/prazoai?sslmode=verify-full",
        "AUTH_JWT_SECRET": JWT,
        "TRUSTED_PROXY_SECRET": PROXY,
        "PUBLIC_APP_ORIGIN": "https://app.prazoai.exemplo",
        "CORS_ORIGINS": "",
        "EMAIL_TRANSPORT": "smtp",
        "EMAIL_FROM": "PrazoAI <nao-responda@prazoai.exemplo>",
        "SMTP_HOST": "smtp.provedor.exemplo",
        "SMTP_PORT": "587",
        "SMTP_SECURITY": "starttls",
        "SMTP_USERNAME": "usuario-smtp",
        "SMTP_PASSWORD": SMTP_PASSWORD,
        "LOG_LEVEL": "INFO",
        # Doc 28: PDFs no Azure Blob privado (conta FICTÍCIA; nada é contatado nos testes sem banco).
        "FILE_STORAGE": "azure_blob",
        "AZURE_STORAGE_CONNECTION_STRING": "DefaultEndpointsProtocol=https;AccountName=contaficticia;"
                                           f"AccountKey={AZ_KEY};EndpointSuffix=core.windows.net",
        "AZURE_STORAGE_CONTAINER": "prazoai-intimacoes",
    }
    for k, v in over.items():
        if v is None:
            env.pop(k, None)
        else:
            env[k] = v
    return env


def problems_for(env: dict[str, str], process_env: dict[str, str] | None = None) -> list[str]:
    from app.core.config import hosted_config_problems

    return hosted_config_problems(Settings(_env_file=None, **env), process_env or {})  # type: ignore[arg-type]


# ------------------------------------------------------------------ sem banco
@pytest.mark.parametrize("environment", ["staging", "production"])
def test_configuracao_completa_ficticia_passa(environment):
    assert problems_for(hosted_env(environment)) == []
    # CORS pode listar exatamente a origem pública.
    assert problems_for(hosted_env(environment, CORS_ORIGINS="https://app.prazoai.exemplo")) == []


CASES = [
    # Isolado do requisito de arquivos (que, sozinho, já exige STORAGE=postgres nas Settings):
    ({"STORAGE": "memory", "FILE_STORAGE": "disabled"}, "STORAGE deve ser postgres"),
    ({"STORAGE": None, "FILE_STORAGE": "disabled"}, "STORAGE deve ser postgres"),
    ({"STORAGE": "memory"}, "exige STORAGE=postgres"),
    ({"AUTH_ENABLED": "false", "OFFICES_ENABLED": "false"}, "AUTH_ENABLED deve ser true"),
    ({"OFFICES_ENABLED": "false"}, "OFFICES_ENABLED"),
    ({"DATABASE_URL": None}, "DATABASE_URL é obrigatória"),
    ({"DATABASE_URL": f"postgresql+psycopg://app:{DB_PASSWORD}@db.exemplo.invalid/prazoai"}, "sslmode"),
    ({"DATABASE_URL": f"postgresql+psycopg://app:{DB_PASSWORD}@db.exemplo.invalid/prazoai?sslmode=prefer"}, "sslmode"),
    ({"DATABASE_URL": f"postgresql+psycopg://app:{DB_PASSWORD}@db.exemplo.invalid/prazoai?sslmode=disable"}, "sslmode"),
    ({"AUTH_JWT_SECRET": None}, "AUTH_JWT_SECRET"),
    ({"TRUSTED_PROXY_SECRET": None}, "TRUSTED_PROXY_SECRET"),
    ({"PUBLIC_APP_ORIGIN": None}, "PUBLIC_APP_ORIGIN"),
    ({"CORS_ORIGINS": "*"}, "'*'"),
    ({"CORS_ORIGINS": "http://localhost:3000"}, "CORS_ORIGINS só pode conter PUBLIC_APP_ORIGIN"),
    ({"CORS_ORIGINS": "https://app.prazoai.exemplo,https://outro.exemplo"}, "CORS_ORIGINS só pode conter"),
    ({"EMAIL_TRANSPORT": "disabled"}, "EMAIL_TRANSPORT deve ser smtp"),
    ({"EMAIL_TRANSPORT": None}, "EMAIL_TRANSPORT deve ser smtp"),
    ({"SMTP_USERNAME": None, "SMTP_PASSWORD": None}, "SMTP_USERNAME e SMTP_PASSWORD"),
    ({"SMTP_HOST": "127.0.0.1"}, "SMTP_HOST não pode ser loopback"),
    ({"SMTP_HOST": "localhost"}, "SMTP_HOST não pode ser loopback"),
    ({"LOG_LEVEL": "DEBUG"}, "LOG_LEVEL"),
    ({"FILE_STORAGE": "disabled"}, "FILE_STORAGE deve ser azure_blob"),
    ({"FILE_STORAGE": None, "AZURE_STORAGE_CONNECTION_STRING": None}, "FILE_STORAGE deve ser azure_blob"),
    ({"AZURE_STORAGE_CONNECTION_STRING": "DefaultEndpointsProtocol=http;AccountName=contaficticia;"
                                         f"AccountKey={AZ_KEY};EndpointSuffix=core.windows.net"}, "https"),
    ({"AZURE_STORAGE_CONNECTION_STRING": "UseDevelopmentStorage=true"}, "não o emulador"),
    ({"AZURE_STORAGE_CONNECTION_STRING": "DefaultEndpointsProtocol=https;AccountName=devstoreaccount1;"
                                         f"AccountKey={AZ_KEY};BlobEndpoint=http://127.0.0.1:10000/devstoreaccount1"},
     "não o emulador"),
    ({"AUTH_STORAGE": "memory"}, "AUTH_STORAGE"),
]


@pytest.mark.parametrize("environment", ["staging", "production"])
@pytest.mark.parametrize("over, fragment", CASES)
def test_requisito_ausente_ou_inseguro_e_recusado(environment, over, fragment):
    """Recusa em uma de duas camadas (ambas impedem o startup): validação das Settings (formas já
    inválidas em qualquer ambiente, ex.: SMTP sem origem pública) ou requisitos de implantação."""
    env = hosted_env(environment, **over)
    try:
        settings = Settings(_env_file=None, **env)  # type: ignore[arg-type]
    except ValueError as exc:
        text = str(exc)
        assert fragment in text, text
    else:
        from app.core.config import hosted_config_problems

        assert any(fragment in p for p in hosted_config_problems(settings, {})), hosted_config_problems(settings, {})
        with pytest.raises(HostedConfigError) as hosted:
            ensure_hosted_requirements(settings, env={})
        text = str(hosted.value)
    for secret in (SMTP_PASSWORD, JWT, PROXY, DB_PASSWORD, AZ_KEY):
        assert secret not in text


@pytest.mark.parametrize("origin", ["http://app.prazoai.exemplo", "https://localhost", "https://127.0.0.1:3000",
                                    "https://app.prazoai.exemplo/caminho"])
def test_origem_publica_insegura_e_recusada(origin):
    # Formatos que já falham na validação de e-mail (E1) aparecem como ValueError das Settings; os demais,
    # como problema de implantação. Em nenhum caso a app inicia.
    try:
        problems = problems_for(hosted_env(PUBLIC_APP_ORIGIN=origin, CORS_ORIGINS=""))
    except ValueError:
        return
    assert any("PUBLIC_APP_ORIGIN" in p for p in problems), problems


def test_varios_workers_recusados():
    assert any("WEB_CONCURRENCY" in p for p in problems_for(hosted_env(), {"WEB_CONCURRENCY": "4"}))
    assert problems_for(hosted_env(), {"WEB_CONCURRENCY": "1"}) == []


def test_smtp_sem_tls_ja_e_recusado_pelas_settings():
    with pytest.raises(ValueError):
        Settings(_env_file=None, **hosted_env(SMTP_SECURITY="none", SMTP_ALLOW_INSECURE_LOCAL="true",  # type: ignore[arg-type]
                                              SMTP_HOST="127.0.0.1", SMTP_USERNAME=None, SMTP_PASSWORD=None))


def test_lista_todos_os_problemas_de_uma_vez():
    problems = problems_for({"ENVIRONMENT": "production"})
    assert len(problems) >= 6
    for fragment in ("STORAGE", "DATABASE_URL", "AUTH_JWT_SECRET", "TRUSTED_PROXY_SECRET", "PUBLIC_APP_ORIGIN",
                     "EMAIL_TRANSPORT"):
        assert any(fragment in p for p in problems), fragment


def test_development_e_test_nao_sao_afetados():
    for environment in ("development", "test"):
        ensure_hosted_requirements(Settings(_env_file=None, ENVIRONMENT=environment), env={})  # type: ignore[arg-type]


def test_manutencao_recusa_ambiente_hospedado_incompleto():
    out = subprocess.run([sys.executable, "-m", "app.maintenance", "purge"], cwd=BACKEND,
                         env={"PATH": "/usr/bin:/bin", **hosted_env(EMAIL_TRANSPORT="disabled")},
                         capture_output=True, text=True, timeout=60)
    assert out.returncode == 2 and "EMAIL_TRANSPORT" in out.stdout
    assert DB_PASSWORD not in out.stdout + out.stderr and SMTP_PASSWORD not in out.stdout + out.stderr


# ------------------------------------------------------------------ com PostgreSQL (TLS) descartável
HOSTED_DB = os.environ.get("PRAZOAI_TEST_HOSTED_DATABASE_URL", "")
_TEST_DB = re.compile(r"^prazoai_test(_[a-z0-9_]+)?$")


@pytest.fixture
def hosted_db():
    if not HOSTED_DB:
        if os.environ.get("PRAZOAI_REQUIRE_HOSTED_TESTS") == "1":
            pytest.fail("PRAZOAI_REQUIRE_HOSTED_TESTS=1 exige PRAZOAI_TEST_HOSTED_DATABASE_URL.")
        pytest.skip("PRAZOAI_TEST_HOSTED_DATABASE_URL não definida (PostgreSQL descartável com TLS).")
    from sqlalchemy import create_engine, text
    from sqlalchemy.engine import make_url

    url = make_url(HOSTED_DB)
    # Mesmas proteções de banco descartável dos demais testes: nome prazoai_test*, host local ou do CI.
    assert url.database and _TEST_DB.fullmatch(url.database), "banco de teste deve ser prazoai_test*"
    assert url.host in {"127.0.0.1", "localhost", "::1", "postgres"}, "host do banco de teste deve ser local"
    assert url.query.get("sslmode") in {"require", "verify-ca", "verify-full"}
    engine = create_engine(url)
    with engine.begin() as conn:
        conn.execute(text("DROP SCHEMA IF EXISTS prazoai CASCADE"))
    engine.dispose()
    target = f"{url.host}:{url.port or 5432}/{url.database}"
    # PGPASSWORD (se houver) é a senha do banco DESCARTÁVEL do CI, entregue fora da URL (libpq a lê).
    pg_env = {k: os.environ[k] for k in ("PGPASSWORD",) if k in os.environ}
    env = {"PATH": "/usr/bin:/bin", **pg_env, **hosted_env("staging", DATABASE_URL=HOSTED_DB)}
    out = subprocess.run([sys.executable, "-m", "alembic", "upgrade", "head"], cwd=BACKEND,
                         env={**env, "PRAZOAI_CONFIRM_MIGRATION_TARGET": target}, capture_output=True, text=True,
                         timeout=120)
    assert out.returncode == 0, out.stderr[-500:]
    assert DB_PASSWORD not in out.stdout + out.stderr
    return HOSTED_DB


class PrivateContainerStub:
    """Dublê do Azure Blob (só `check`): os testes de arquivos reais usam o Azurite (test_intimation_files)."""

    def check(self):
        return None


def _app(monkeypatch, environment, db_url, **over):
    from app.main import create_app

    for k, v in hosted_env(environment, DATABASE_URL=db_url, AUTH_REGISTER_MAX_REQUESTS="2", **over).items():
        monkeypatch.setenv(k, v)
    monkeypatch.delenv("WEB_CONCURRENCY", raising=False)
    get_settings.cache_clear()
    try:
        # O armazenamento de arquivos real (Azure) não é contatado: dublê que confirma container privado.
        return create_app(file_store=PrivateContainerStub())
    finally:
        get_settings.cache_clear()


def _proxied(ip: str) -> dict[str, str]:
    return {"X-PrazoAI-Proxy-Secret": PROXY, "X-PrazoAI-Client-IP": ip}


@pytest.mark.parametrize("environment", ["staging", "production"])
def test_app_hospedada_real(monkeypatch, hosted_db, environment):
    app = _app(monkeypatch, environment, hosted_db)
    with TestClient(app, raise_server_exceptions=False) as client:
        for path in ("/docs", "/redoc", "/openapi.json"):
            assert client.get(path).status_code == 404, path
        assert client.get("/api/v1/health").json()["durable"] is True
        ready = client.get("/api/v1/health/ready")
        assert ready.status_code == 200 and ready.json()["checks"] == {"database": "ok", "schema": "ok", "files": "ok"}
        # IP do cliente: só pelo intermediário com segredo; X-Forwarded-For e segredo errado são ignorados.
        pw = "Senha-forte-hospedada-123"
        body = lambda n: {"name": "Pessoa Ficticia", "email": f"p{n}-{environment}@exemplo.com", "password": pw}  # noqa: E731
        assert client.post("/api/v1/auth/register", json=body(1), headers=_proxied("198.51.100.10")).status_code == 201
        assert client.post("/api/v1/auth/register", json=body(2), headers=_proxied("198.51.100.10")).status_code == 201
        assert client.post("/api/v1/auth/register", json=body(3), headers=_proxied("198.51.100.10")).status_code == 429
        assert client.post("/api/v1/auth/register", json=body(4), headers=_proxied("198.51.100.11")).status_code == 201
        forged = {"X-PrazoAI-Proxy-Secret": "x" * 48, "X-PrazoAI-Client-IP": "203.0.113.9",
                  "X-Forwarded-For": "203.0.113.9"}
        assert client.post("/api/v1/auth/register", json=body(5), headers=forged).status_code == 201
        assert client.post("/api/v1/auth/register", json=body(6), headers=forged).status_code == 201
        assert client.post("/api/v1/auth/register", json=body(7), headers=forged).status_code == 429   # IP observado
        login = client.post("/api/v1/auth/login", json={"email": f"p1-{environment}@exemplo.com", "password": pw},
                            headers=_proxied("198.51.100.12"))
        assert login.status_code == 200
        tokens = login.json()
    # Reinício: nova instância lê usuário e sessão do PostgreSQL.
    app2 = _app(monkeypatch, environment, hosted_db)
    with TestClient(app2, raise_server_exceptions=False) as client:
        me = client.get("/api/v1/auth/me", headers={"Authorization": f"Bearer {tokens['accessToken']}"})
        assert me.status_code == 200 and me.json()["user"]["email"] == f"p1-{environment}@exemplo.com"
        refreshed = client.post("/api/v1/auth/refresh", json={"refreshToken": tokens["refreshToken"]})
        assert refreshed.status_code == 200


def test_readiness_indisponivel_sem_detalhes(monkeypatch, hosted_db):
    from sqlalchemy import create_engine, text
    from sqlalchemy.engine import make_url

    app = _app(monkeypatch, "production", hosted_db)
    with TestClient(app, raise_server_exceptions=False) as client:
        assert client.get("/api/v1/health/ready").status_code == 200
        engine = create_engine(make_url(hosted_db))
        with engine.begin() as conn:
            conn.execute(text("UPDATE prazoai.alembic_version SET version_num = '0002'"))
        try:
            r = client.get("/api/v1/health/ready")
            assert r.status_code == 503 and r.json() == {"status": "unavailable",
                                                         "checks": {"database": "ok", "schema": "fail"}}
        finally:
            with engine.begin() as conn:
                conn.execute(text("UPDATE prazoai.alembic_version SET version_num = '0004'"))
            engine.dispose()


# ------------------------------------------------------------------ Entrar com Google (doc 30)
def test_google_client_id_e_aceito_em_producao():
    assert problems_for(hosted_env(GOOGLE_CLIENT_ID="123-abc.apps.googleusercontent.com")) == []


@pytest.mark.parametrize("var", ["GOOGLE_JWKS_URL", "GOOGLE_ISSUER"])
def test_enderecos_de_teste_do_google_recusados_em_producao(var):
    found = problems_for(hosted_env(GOOGLE_CLIENT_ID="123-abc.apps.googleusercontent.com", **{var: "http://127.0.0.1:1/x"}))
    assert any("GOOGLE_JWKS_URL/GOOGLE_ISSUER" in p for p in found)
