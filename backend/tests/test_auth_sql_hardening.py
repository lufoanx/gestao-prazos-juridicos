"""P3 (correções da auditoria) — PostgreSQL real:

1. expiração da recuperação: a mensagem informa a expiração EFETIVAMENTE persistida (relógio pós-lock);
2. D6: deadlock (40P01) e lock_timeout (55P03) → 409 `concurrent_update`, com rollback, conexão
   devolvida e SEM repetição automática; outros erros do banco continuam inesperados;
3. equivalentes SQL dos quatro testes `memory_only` (valores inspecionados no banco).
"""
from __future__ import annotations

import uuid
from datetime import timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import func, select, text
from sqlalchemy.exc import DBAPIError

from app.core.errors import ConcurrentUpdateError
from app.db.tables import auth_sessions, auth_used_refresh_hashes, password_reset_tokens, users
from app.security.tokens import hash_opaque_token
from tests.auth_sql_support import Gates, Runner, backend_pid, control_connection, wait_for_lock_waiter
from tests.conftest import CapturingDelivery, FakeClock

pytestmark = pytest.mark.postgres
API = "/api/v1"
PASSWORD = "Senha-forte-123"
EMAIL = "ana@exemplo.com"


def register_and_login(client, email=EMAIL):
    assert client.post(f"{API}/auth/register", json={"name": "Ana", "email": email, "password": PASSWORD}
                       ).status_code == 201
    resp = client.post(f"{API}/auth/login", json={"email": email, "password": PASSWORD})
    assert resp.status_code == 200, resp.text
    return resp.json()


def bearer(token):
    return {"Authorization": f"Bearer {token}"}


def user_uuid(engine, email=EMAIL) -> uuid.UUID:
    with engine.connect() as c:
        return c.execute(select(users.c.id).where(users.c.email == email)).scalar_one()


def lock_row(conn, key_col, key) -> None:
    conn.execute(select(key_col).where(key_col == key).with_for_update())


# ---------------------------------------------------------------- 1. expiração efetiva da recuperação
def test_mensagem_usa_a_expiracao_persistida_apos_espera_pelo_bloqueio(pg_app, pg_schema):
    clock, delivery = FakeClock(), CapturingDelivery()
    app = pg_app(clock=clock, delivery=delivery, AUTH_PASSWORD_RESET_TTL_SECONDS="900")
    with TestClient(app) as client:
        register_and_login(client)
        uid = user_uuid(pg_schema)
        before = clock.now()
        t = Runner(app.state.auth.service.forgot_password, EMAIL)
        with control_connection(pg_schema) as holder:                          # rollback/close em finally
            lock_row(holder, users.c.id, uid)                                  # o teste segura o usuário
            t.start()
            wait_for_lock_waiter(pg_schema, blocked_by=backend_pid(holder))     # emissão PRESA nesse bloqueio
            clock.advance(120)                                                 # tempo passa durante a espera
            holder.rollback()                                                  # libera
        t.join_result()
        assert len(delivery.messages) == 1
        message = delivery.messages[0]
        with pg_schema.connect() as c:
            persisted = c.execute(select(password_reset_tokens.c.expires_at, password_reset_tokens.c.created_at)
                                  ).one()
        assert message.expires_at == persisted.expires_at                       # entregue == persistida
        assert persisted.created_at == before + timedelta(seconds=120)          # relógio pós-lock
        assert message.expires_at == before + timedelta(seconds=120 + 900)
        assert message.expires_at != before + timedelta(seconds=900)            # não a pré-transação
        token = message.token
        # Válido imediatamente antes da expiração…
        assert app.state.auth.service._resets.is_active(hash_opaque_token(token),
                                                        message.expires_at - timedelta(microseconds=1))
        # …e recusado no instante EXATO.
        clock.advance((message.expires_at - clock.now()).total_seconds())
        assert clock.now() == message.expires_at
        resp = client.post(f"{API}/auth/reset-password", json={"token": token, "newPassword": "Outra-senha-456"})
        assert resp.status_code == 400 and resp.json()["error"]["code"] == "invalid_reset_token"


def test_redefinicao_um_instante_antes_da_expiracao_funciona(pg_app):
    clock, delivery = FakeClock(), CapturingDelivery()
    app = pg_app(clock=clock, delivery=delivery, AUTH_PASSWORD_RESET_TTL_SECONDS="900")
    with TestClient(app) as client:
        register_and_login(client)
        assert client.post(f"{API}/auth/forgot-password", json={"email": EMAIL}).status_code == 202
        message = delivery.messages[-1]
        clock.advance((message.expires_at - clock.now()).total_seconds() - 0.000001)
        body = {"token": message.token, "newPassword": "Outra-senha-456"}
        assert client.post(f"{API}/auth/reset-password", json=body).status_code == 204


def test_transacao_que_falha_nao_entrega_mensagem(pg_app, pg_schema, caplog):
    gates, delivery = Gates(), CapturingDelivery()
    app = pg_app(delivery=delivery, sql_checkpoint=gates)
    with TestClient(app) as client:
        register_and_login(client)
        gates.fail_at("forgot:before_commit")                               # falha DEPOIS do INSERT, antes do COMMIT
        with pytest.raises(RuntimeError):
            app.state.auth.service.forgot_password(EMAIL)
    assert delivery.messages == []                                          # nada entregue
    with pg_schema.connect() as c:
        assert c.execute(select(func.count()).select_from(password_reset_tokens)).scalar_one() == 0


# ---------------------------------------------------------------- 2. D6: conflito de concorrência
def _spy(obj, name):
    calls = []
    original = getattr(obj, name)

    def wrapper(*a, **k):
        calls.append(1)
        return original(*a, **k)

    setattr(obj, name, wrapper)
    return calls


def test_lock_timeout_vira_409_sem_alteracoes_e_sem_repeticao(pg_app, pg_schema):
    app = pg_app(DATABASE_LOCK_TIMEOUT_MS="300", DATABASE_STATEMENT_TIMEOUT_MS="2000")
    with TestClient(app) as client:
        register_and_login(client)
        with pg_schema.connect() as c:
            sessions_before = c.execute(select(func.count()).select_from(auth_sessions)).scalar_one()
        calls = _spy(app.state.auth.service._sessions, "add_if_credentials_current")
        with control_connection(pg_schema) as holder:                          # rollback/close em finally
            lock_row(holder, users.c.id, user_uuid(pg_schema))
            resp = client.post(f"{API}/auth/login", json={"email": EMAIL, "password": PASSWORD})
        assert resp.status_code == 409
        assert resp.json() == {"error": {"code": "concurrent_update",
                                         "message": "Outra operação simultânea impediu esta. Tente novamente."}}
        assert not any(x in resp.text for x in ("55P03", "lock", "SQL", "psycopg"))
        assert calls == [1]                                                 # uma única tentativa
        with pg_schema.connect() as c:
            assert c.execute(select(func.count()).select_from(auth_sessions)).scalar_one() == sessions_before
        assert app.state.auth.engine.pool.checkedout() == 0                 # conexão devolvida
        assert client.post(f"{API}/auth/login", json={"email": EMAIL, "password": PASSWORD}).status_code == 200


def test_deadlock_real_qualquer_vitima_estado_final_coerente(pg_app, pg_schema):
    """DEADLOCK REAL entre a aplicação (refresh) e uma conexão de controle do teste.

    O PostgreSQL escolhe a vítima; essa escolha NÃO é contratual, então o teste aceita qualquer uma
    (sem repetir o cenário) e verifica o SQLSTATE e o estado final correspondentes:
    - vítima = aplicação → HTTP 409 `concurrent_update`, nada alterado, token original segue válido;
    - vítima = controle  → 40P01 na conexão de controle; a aplicação conclui a rotação (HTTP 200).
    Em ambos os casos: uma única chamada ao repositório (sem repetição) e conexões devolvidas.
    """
    app = pg_app()
    with TestClient(app) as client:
        tokens = register_and_login(client)
        uid = user_uuid(pg_schema)
        with pg_schema.connect() as c:
            sid = c.execute(select(auth_sessions.c.id)).scalar_one()
        calls = _spy(app.state.auth.service._sessions, "rotate_refresh")
        t = Runner(client.post, f"{API}/auth/refresh", json={"refreshToken": tokens["refreshToken"]})
        control_error = None
        with control_connection(pg_schema) as holder:                          # rollback/close em finally
            lock_row(holder, auth_sessions.c.id, sid)                          # 1) controle segura a SESSÃO
            t.start()                                                          # 2) app: users FOR SHARE → sessão
            wait_for_lock_waiter(pg_schema, blocked_by=backend_pid(holder))     # app vista esperando a sessão
            try:                                                               # 3) controle pede users: ciclo
                lock_row(holder, users.c.id, uid)
            except DBAPIError as exc:
                control_error = exc
            holder.rollback()
        resp = t.join_result()
        assert calls == [1]                                                    # sem repetição automática
        assert app.state.auth.engine.pool.checkedout() == 0
        with pg_schema.connect() as c:
            row = c.execute(select(auth_sessions.c.revoked_at, auth_sessions.c.rotation_count)).one()
            used = c.execute(select(func.count()).select_from(auth_used_refresh_hashes)).scalar_one()
        if control_error is None:                                              # vítima: aplicação
            assert resp.status_code == 409 and resp.json()["error"]["code"] == "concurrent_update"
            assert not any(x in resp.text for x in ("40P01", "deadlock", "SQL", "psycopg"))
            assert (row.revoked_at, row.rotation_count, used) == (None, 0, 0)  # rollback integral
            again = client.post(f"{API}/auth/refresh", json={"refreshToken": tokens["refreshToken"]})
            assert again.status_code == 200                                    # token original segue válido
        else:                                                                  # vítima: controle
            assert getattr(control_error.orig, "sqlstate", None) == "40P01"
            assert resp.status_code == 200, resp.text                          # a aplicação concluiu
            assert (row.revoked_at, row.rotation_count, used) == (None, 1, 1)  # rotação completa, não parcial
            nxt = client.post(f"{API}/auth/refresh", json={"refreshToken": resp.json()["refreshToken"]})
            assert nxt.status_code == 200                                      # o novo token é o válido


def test_traducao_http_de_40p01_por_injecao_controlada(pg_app, pg_schema):
    """INJEÇÃO CONTROLADA (não substitui o deadlock real acima): prova DETERMINÍSTICA de que um erro
    do driver com SQLSTATE 40P01 levantado DENTRO da transação atravessa `SqlContext` e vira HTTP
    409 `concurrent_update`, depois do ROLLBACK e da devolução da conexão, sem repetição.

    O erro é um `psycopg.errors.DeadlockDetected` (SQLSTATE 40P01) embrulhado como o SQLAlchemy faz
    (`OperationalError`), lançado no ponto de controle `rotate:locked`, ou seja, depois de a rotação
    obter os bloqueios e antes de qualquer escrita.
    """
    import psycopg
    from sqlalchemy.exc import OperationalError

    injected: list[str] = []

    def checkpoint(name: str) -> None:
        if name == "rotate:locked" and not injected:
            injected.append(name)
            raise OperationalError("<injeção controlada>", {}, psycopg.errors.DeadlockDetected("injeção controlada"))

    app = pg_app(sql_checkpoint=checkpoint)
    with TestClient(app) as client:
        tokens = register_and_login(client)
        calls = _spy(app.state.auth.service._sessions, "rotate_refresh")
        resp = client.post(f"{API}/auth/refresh", json={"refreshToken": tokens["refreshToken"]})
        assert injected == ["rotate:locked"]                                   # a injeção ocorreu, uma vez
        assert resp.status_code == 409
        assert resp.json() == {"error": {"code": "concurrent_update",
                                         "message": "Outra operação simultânea impediu esta. Tente novamente."}}
        assert not any(x in resp.text for x in ("40P01", "deadlock", "injeção", "SQL", "psycopg"))
        assert calls == [1]                                                    # sem repetição automática
        assert app.state.auth.engine.pool.checkedout() == 0                    # conexão devolvida
        with pg_schema.connect() as c:
            row = c.execute(select(auth_sessions.c.revoked_at, auth_sessions.c.rotation_count)).one()
            used = c.execute(select(func.count()).select_from(auth_used_refresh_hashes)).scalar_one()
        assert (row.revoked_at, row.rotation_count, used) == (None, 0, 0)      # nada parcial
        again = client.post(f"{API}/auth/refresh", json={"refreshToken": tokens["refreshToken"]})
        assert again.status_code == 200                                        # token original segue válido


def test_outros_erros_do_banco_continuam_inesperados(pg_schema):
    from app.repositories.sql import SqlContext

    ctx = SqlContext(engine=pg_schema, clock=FakeClock())
    with pytest.raises(DBAPIError) as exc:
        with ctx.transaction() as conn:
            conn.execute(text("SET LOCAL statement_timeout = '50ms'"))
            conn.execute(text("SELECT pg_sleep(1)"))                        # 57014: NÃO é conflito
    assert not isinstance(exc.value, ConcurrentUpdateError)
    assert getattr(exc.value.orig, "sqlstate", None) == "57014"
    assert pg_schema.pool.checkedout() == 0


# ---------------------------------------------------------------- 3. equivalentes SQL dos testes memory_only
def table_dump(engine, table) -> str:
    """Conteúdo textual de TODAS as colunas de TODAS as linhas da tabela."""
    with engine.connect() as c:
        return "\n".join(r[0] for r in c.execute(text(f"SELECT t::text FROM prazoai.{table.name} AS t")))


def test_sql_senha_armazenada_somente_como_argon2id(pg_app, pg_schema):
    with TestClient(pg_app()) as client:
        user_id = client.post(f"{API}/auth/register", json={"name": "Ana", "email": EMAIL, "password": PASSWORD}
                              ).json()["id"]
    with pg_schema.connect() as c:
        stored = c.execute(select(users.c.password_hash).where(users.c.id == uuid.UUID(user_id))).scalar_one()
    assert stored.startswith("$argon2id$") and PASSWORD not in stored
    for table in (users, auth_sessions, auth_used_refresh_hashes, password_reset_tokens):
        assert PASSWORD not in table_dump(pg_schema, table)


def test_sql_refresh_token_armazenado_somente_como_hash(pg_app, pg_schema):
    with TestClient(pg_app()) as client:
        first = register_and_login(client)
        second = client.post(f"{API}/auth/refresh", json={"refreshToken": first["refreshToken"]}).json()
    with pg_schema.connect() as c:
        current = c.execute(select(auth_sessions.c.current_refresh_hash)).scalar_one()
        used = c.execute(select(auth_used_refresh_hashes.c.refresh_hash)).scalars().all()
    assert current == hash_opaque_token(second["refreshToken"])
    assert used == [hash_opaque_token(first["refreshToken"])]
    dump = table_dump(pg_schema, auth_sessions) + table_dump(pg_schema, auth_used_refresh_hashes)
    assert first["refreshToken"] not in dump and second["refreshToken"] not in dump


def test_sql_token_de_recuperacao_armazenado_somente_como_hash(pg_app, pg_schema):
    delivery = CapturingDelivery()
    with TestClient(pg_app(delivery=delivery)) as client:
        register_and_login(client)
        for _ in range(2):
            assert client.post(f"{API}/auth/forgot-password", json={"email": EMAIL}).status_code == 202
    tokens = [m.token for m in delivery.messages]
    assert len(set(tokens)) == 2 and all(len(t) >= 40 for t in tokens)
    with pg_schema.connect() as c:
        stored = set(c.execute(select(password_reset_tokens.c.token_hash)).scalars())
    assert stored == {hash_opaque_token(t) for t in tokens}
    dump = table_dump(pg_schema, password_reset_tokens)
    assert not any(t in dump for t in tokens)


def test_sql_reset_revoga_todas_as_sessoes_e_invalida_os_tokens_aplicaveis(pg_app, pg_schema):
    """Adaptação: o teste em memória injetava um 2º token PENDENTE, o que a constraint de token ativo
    único impede (correto). Equivalente: o token anterior, invalidado na nova emissão, continua
    inválido depois da redefinição; o token usado fica consumido; todas as sessões são revogadas."""
    delivery = CapturingDelivery()
    with TestClient(pg_app(delivery=delivery)) as client:
        s1 = register_and_login(client)
        s2 = client.post(f"{API}/auth/login", json={"email": EMAIL, "password": PASSWORD}).json()
        client.post(f"{API}/auth/forgot-password", json={"email": EMAIL})
        client.post(f"{API}/auth/forgot-password", json={"email": EMAIL})
        older, latest = (m.token for m in delivery.messages)
        assert client.post(f"{API}/auth/reset-password", json={"token": latest, "newPassword": "Outra-senha-456"}
                           ).status_code == 204
        for s in (s1, s2):
            assert client.get(f"{API}/auth/me", headers=bearer(s["accessToken"])).status_code == 401
            assert client.post(f"{API}/auth/refresh", json={"refreshToken": s["refreshToken"]}).status_code == 401
        assert client.post(f"{API}/auth/reset-password", json={"token": older, "newPassword": "Mais-uma-789"}
                           ).status_code == 400
    with pg_schema.connect() as c:
        rows = {r.token_hash: r for r in c.execute(select(password_reset_tokens))}
        revoked = c.execute(select(func.count()).select_from(auth_sessions).where(
            auth_sessions.c.revoked_at.is_(None))).scalar_one()
    assert rows[hash_opaque_token(latest)].used_at is not None
    assert rows[hash_opaque_token(older)].invalidated_at is not None and rows[hash_opaque_token(older)].used_at is None
    assert revoked == 0                                                     # nenhuma sessão ativa
