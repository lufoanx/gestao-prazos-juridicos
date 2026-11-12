"""Modos de armazenamento e fluxos HTTP da autenticação no PostgreSQL.

P4: os modos FINAIS são `memory` e `postgres` (autenticação E domínio no banco). O modo intermediário
`auth-postgres` da P3 foi removido e agora é recusado; as expectativas abaixo foram atualizadas para
isso (cada teste antigo de `auth-postgres` virou o equivalente em `postgres` ou a verificação da recusa).

Configurações aceitas/recusadas (sem banco) e, com PostgreSQL real (fixture protegida): esquema
ausente ou desatualizado recusado sem escrita; fluxos HTTP completos; revogações que persistem
apesar da resposta 401; reinício da aplicação e do engine preservando usuários, sessões e tokens;
domínio em memória usando o MESMO repositório SQL de usuários.
"""
from __future__ import annotations

import logging
import subprocess
import sys
import uuid
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError
from sqlalchemy import func, select, text

from app.core.config import ProductionNotReleasedError, Settings
from tests.conftest import CapturingDelivery, FakeClock

API = "/api/v1"
BACKEND = Path(__file__).resolve().parents[1]
JWT = "segredo-jwt-estavel-dos-testes-p3-" + "x" * 32   # estável: reinício não perde tokens por segredo efêmero
PASSWORD = "Senha-forte-123"


def settings(**env):
    return Settings(_env_file=None, **env)  # type: ignore[arg-type]


# ---------------------------------------------------------------- configuração (sem banco)
@pytest.mark.parametrize("env", [
    {"STORAGE": "postgres", "ENVIRONMENT": "test"},
    {"STORAGE": "postgres", "ENVIRONMENT": "development"},
])
def test_modo_postgres_autorizado(env):
    assert settings(**env).storage == "postgres"


@pytest.mark.parametrize("env, reason", [
    ({"STORAGE": "auth-postgres", "ENVIRONMENT": "test"}, "removido na P4"),
    ({"STORAGE": "auth-postgres", "ENVIRONMENT": "development", "ALLOW_VOLATILE_DOMAIN": "true"}, "removido na P4"),
    ({"STORAGE": "postgres", "ENVIRONMENT": "staging", "AUTH_JWT_SECRET": JWT}, "development ou test"),
    ({"STORAGE": "postgres", "ENVIRONMENT": "production", "AUTH_JWT_SECRET": JWT}, "development ou test"),
    ({"STORAGE": "postgres", "ENVIRONMENT": "test", "AUTH_STORAGE": "memory"}, "AUTH_STORAGE"),
])
def test_modos_recusados(env, reason):
    with pytest.raises(ValidationError) as exc:
        settings(**env)
    assert reason in str(exc.value)


def test_erros_de_configuracao_nao_exibem_valores(monkeypatch):
    with pytest.raises(ValidationError) as exc:
        settings(STORAGE="postgres", ENVIRONMENT="staging",
                 DATABASE_URL="postgresql+psycopg://u:SEGREDO-P3@localhost/db", AUTH_JWT_SECRET=JWT)
    assert "SEGREDO" not in str(exc.value) and "GREDO" not in str(exc.value) and "xxxx" not in str(exc.value)


def test_postgres_sem_database_url_recusa_iniciar(make_app):
    from app.services.auth_container import AuthStorageConfigError

    with pytest.raises(AuthStorageConfigError, match="DATABASE_URL"):
        make_app(STORAGE="postgres", ENVIRONMENT="test", AUTH_JWT_SECRET=JWT, DATABASE_URL="")


def test_producao_continua_bloqueada(make_app):
    with pytest.raises((ProductionNotReleasedError, ValidationError)):
        make_app(ENVIRONMENT="production", STORAGE="postgres", AUTH_JWT_SECRET=JWT)


def test_modo_memory_nao_importa_sqlalchemy_nem_os_repositorios_sql():
    script = ("import sys; from app.main import create_app; create_app(); "
              "print('sqlalchemy' in sys.modules, 'psycopg' in sys.modules, 'app.repositories.sql' in sys.modules)")
    out = subprocess.run([sys.executable, "-c", script], cwd=BACKEND, capture_output=True, text=True, timeout=60,
                         env={"PATH": "/usr/bin:/bin", "DATABASE_URL": "postgresql+psycopg://u:p@localhost/x"})
    assert out.returncode == 0, out.stderr[-300:]
    assert out.stdout.strip().endswith("False False False")


def test_health_em_memory_mantem_o_contrato(make_app):
    client = TestClient(make_app())
    assert client.get(f"{API}/health").json() == {"status": "ok", "service": "prazoai-backend"}


# ---------------------------------------------------------------- com PostgreSQL real
def register_and_login(client, email="ana@exemplo.com"):
    assert client.post(f"{API}/auth/register", json={"name": "Ana", "email": email, "password": PASSWORD}
                       ).status_code == 201
    resp = client.post(f"{API}/auth/login", json={"email": email, "password": PASSWORD})
    assert resp.status_code == 200, resp.text
    return resp.json()


def bearer(token):
    return {"Authorization": f"Bearer {token}"}


@pytest.mark.postgres
def test_esquema_desatualizado_ou_ausente_recusado_sem_escrita(pg_clean, pg_url, make_app):
    from alembic import command

    from app.repositories.sql import SchemaNotReadyError
    from tests.conftest import alembic_config_for

    def state():
        with pg_clean.connect() as c:
            tables = c.execute(text(
                "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'prazoai'")).scalar_one()
            exists = c.execute(text("SELECT to_regclass('prazoai.alembic_version') IS NOT NULL")).scalar_one()
            rev = None
            if exists:
                rev = c.execute(text("SELECT version_num FROM prazoai.alembic_version")).scalar_one_or_none()
        return tables, rev

    raw = pg_url.render_as_string(hide_password=False)
    for target in ("0002", "0001", "base"):                         # exigida: 0003
        with pg_clean.begin() as conn:
            command.downgrade(alembic_config_for(conn), target)
        before = state()
        with pytest.raises(SchemaNotReadyError):
            make_app(STORAGE="postgres", ENVIRONMENT="test", DATABASE_URL=raw, AUTH_JWT_SECRET=JWT)
        assert state() == before                                        # nada criado nem migrado
    with pg_clean.begin() as conn:
        command.upgrade(alembic_config_for(conn), "head")


@pytest.mark.postgres
def test_fluxos_http_completos_no_postgres(pg_app, caplog):
    delivery = CapturingDelivery()
    with caplog.at_level(logging.INFO):
        app = pg_app(delivery=delivery)
    assert "storage_postgres" in caplog.text
    with TestClient(app) as client:
        assert client.get(f"{API}/health").json() == {"status": "ok", "service": "prazoai-backend",
                                                      "storage": "postgres", "durable": True}
        tokens = register_and_login(client)
        dup = client.post(f"{API}/auth/register", json={"name": "B", "email": "ANA@exemplo.com", "password": PASSWORD})
        assert dup.json()["error"]["code"] == "email_already_registered"       # normalizado e único
        assert client.get(f"{API}/auth/me", headers=bearer(tokens["accessToken"])).status_code == 200
        assert client.patch(f"{API}/users/me", json={"name": "Ana Paula"}, headers=bearer(tokens["accessToken"])
                            ).json()["name"] == "Ana Paula"
        refreshed = client.post(f"{API}/auth/refresh", json={"refreshToken": tokens["refreshToken"]}).json()
        reuse = client.post(f"{API}/auth/refresh", json={"refreshToken": tokens["refreshToken"]})
        assert reuse.status_code == 401 and reuse.json()["error"]["code"] == "invalid_refresh_token"
        revoked_family = client.get(f"{API}/auth/me", headers=bearer(refreshed["accessToken"]))
        assert revoked_family.status_code == 401                                # família revogada
        tokens = client.post(f"{API}/auth/login", json={"email": "ana@exemplo.com", "password": PASSWORD}).json()
        assert client.post(f"{API}/auth/forgot-password", json={"email": "ana@exemplo.com"}).status_code == 202
        token = delivery.messages[-1].token
        assert client.post(f"{API}/auth/reset-password", json={"token": token, "newPassword": "Outra-senha-456"}
                           ).status_code == 204
        assert client.get(f"{API}/auth/me", headers=bearer(tokens["accessToken"])).status_code == 401  # reset revoga
        assert client.post(f"{API}/auth/login", json={"email": "ana@exemplo.com", "password": PASSWORD}
                           ).status_code == 401
        new = client.post(f"{API}/auth/login", json={"email": "ana@exemplo.com", "password": "Outra-senha-456"}).json()
        assert client.post(f"{API}/auth/logout", headers=bearer(new["accessToken"])).status_code == 204
        assert client.get(f"{API}/auth/me", headers=bearer(new["accessToken"])).status_code == 401
        auth = app.state.auth
    assert auth._closed is True                                            # lifespan encerrou o engine
    assert auth.engine.pool.checkedout() == 0


@pytest.mark.postgres
def test_dominio_em_memoria_usa_o_mesmo_repositorio_sql_de_usuarios(pg_app):
    from app.repositories.sql import SqlUserRepository

    app = pg_app(OFFICES_ENABLED="true")
    with TestClient(app) as client:
        assert isinstance(app.state.auth.users, SqlUserRepository)
        assert app.state.org.service._users is app.state.auth.users          # sem segunda cópia de contas
        tokens = register_and_login(client, "gestora@exemplo.com")
        resp = client.post(f"{API}/offices", json={"name": "Escritório P3"}, headers=bearer(tokens["accessToken"]))
        assert resp.status_code == 201, resp.text
        office_id = resp.json()["office"]["id"]
        members = client.get(f"{API}/offices/{office_id}/members", headers=bearer(tokens["accessToken"]))
        assert members.json()["members"][0]["name"] == "Ana"                 # nome lido do PostgreSQL


@pytest.mark.postgres
def test_revogacao_por_teto_persiste_apesar_do_401(pg_app, pg_schema):
    from app.db.tables import auth_sessions

    app = pg_app(AUTH_MAX_REFRESH_ROTATIONS_PER_SESSION="10")
    with TestClient(app) as client:
        tokens = register_and_login(client)
        first = tokens["refreshToken"]
        for _ in range(10):
            tokens = client.post(f"{API}/auth/refresh", json={"refreshToken": tokens["refreshToken"]}).json()
        resp = client.post(f"{API}/auth/refresh", json={"refreshToken": tokens["refreshToken"]})
        assert resp.status_code == 401 and resp.json()["error"]["code"] == "session_rotation_limit_reached"
        reuse = client.post(f"{API}/auth/refresh", json={"refreshToken": first})
        assert reuse.json()["error"]["code"] == "invalid_refresh_token"         # 1º token: reutilização
    with pg_schema.connect() as c:                                               # outra conexão: revogação confirmada
        row = c.execute(select(auth_sessions.c.revoked_at, auth_sessions.c.rotation_count)).one()
    assert row.revoked_at is not None and row.rotation_count == 10


@pytest.mark.postgres
def test_reinicio_da_aplicacao_e_do_engine_preserva_usuarios_sessoes_e_tokens(pg_app, pg_schema):
    from app.db.tables import users

    clock, delivery = FakeClock(), CapturingDelivery()
    app1 = pg_app(clock=clock, delivery=delivery)
    with TestClient(app1) as client:
        tokens = register_and_login(client)
        assert client.post(f"{API}/auth/forgot-password", json={"email": "ana@exemplo.com"}).status_code == 202
    engine1 = app1.state.auth.engine
    assert app1.state.auth._closed is True                                  # 1ª instância encerrada

    app2 = pg_app(clock=clock, delivery=delivery)                          # nova app, NOVO engine
    assert app2.state.auth.engine is not engine1
    with TestClient(app2) as client:
        me = client.get(f"{API}/auth/me", headers=bearer(tokens["accessToken"]))
        assert me.json()["user"]["email"] == "ana@exemplo.com"
        refreshed = client.post(f"{API}/auth/refresh", json={"refreshToken": tokens["refreshToken"]})
        assert refreshed.status_code == 200                                 # sessão persistida
        reset = {"token": delivery.messages[-1].token, "newPassword": "Depois-do-reinicio-1"}
        assert client.post(f"{API}/auth/reset-password", json=reset).status_code == 204
        assert client.post(f"{API}/auth/login", json={"email": "ana@exemplo.com", "password": "Depois-do-reinicio-1"}
                           ).status_code == 200
    with pg_schema.connect() as c:
        assert c.execute(select(func.count()).select_from(users)).scalar_one() == 1
        assert c.execute(select(users.c.credential_version)).scalar_one() == 1


@pytest.mark.postgres
def test_logs_nao_registram_senhas_hashes_tokens_nem_url(pg_app, caplog, pg_url):
    delivery = CapturingDelivery()
    with caplog.at_level(logging.DEBUG):
        app = pg_app(delivery=delivery)
        with TestClient(app) as client:
            tokens = register_and_login(client)
            client.post(f"{API}/auth/refresh", json={"refreshToken": tokens["refreshToken"]})
            client.post(f"{API}/auth/forgot-password", json={"email": "ana@exemplo.com"})
    secrets = [PASSWORD, tokens["refreshToken"], tokens["accessToken"], delivery.messages[-1].token]
    if pg_url.password:
        secrets.append(pg_url.password)
    assert not any(s in caplog.text for s in secrets)
    assert "$argon2" not in caplog.text
    _ = uuid
