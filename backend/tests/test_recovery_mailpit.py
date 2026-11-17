"""E3 — recuperação de senha ponta a ponta no backend com PostgreSQL REAL e capturador SMTP REAL (Mailpit).

Caminho exercitado (sem dublês no fluxo): POST /auth/forgot-password → fila → worker → emissão atômica no
PostgreSQL → COMMIT → subprocesso SMTP da E1 → capturador. A API do capturador é consultada SÓ aqui.

Classificação:
- REAL: PostgreSQL descartável (fixtures protegidas), transporte SMTP em subprocesso, Mailpit local.
- SIMULAÇÃO controlada (identificada no teste): servidor SMTP lento (`tests/smtp_test_server.py`, que
  segura a saudação) para o prazo total; porta fechada para "servidor indisponível".
Coordenação: espera do worker por Condition (`drain`), gate no envio e condições observáveis na API do
capturador (prazo só de proteção). Sem sleeps para ordenar cenários, sem retries.
Nenhuma asserção imprime corpo, link ou token (o `repr` das mensagens capturadas é opaco).
"""
from __future__ import annotations

import contextvars
import logging
import socket
import threading
import urllib.parse
from datetime import datetime
from zoneinfo import ZoneInfo

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import event, func, select

from app.db.tables import password_reset_tokens, users
from app.recovery.dispatcher import WORKER_THREAD_NAME, DispatcherState
from app.security.tokens import hash_opaque_token
from tests.auth_utils import API, PASSWORD, bearer, register, register_and_login
from tests.mailpit_support import FROM_ADDRESS, FROM_NAME, ORIGIN, smtp_env
from tests.recovery_support import WAIT, dispatcher, drain
from tests.test_email_transport import live_children

pytestmark = [pytest.mark.postgres, pytest.mark.mailpit]
EMAIL = "ana@exemplo.com"
NEW_PASSWORD = "Nova-senha-segura-456"
TZ = "America/Sao_Paulo"
GENERIC = {"message": "Se o e-mail estiver cadastrado, enviaremos instruções de recuperação."}


def post_forgot(client, email=EMAIL):
    return client.post(f"{API}/auth/forgot-password", json={"email": email})


def transport_of(app):
    return dispatcher(app)._delivery._transport


def reset_link_parts(text: str) -> urllib.parse.SplitResult:
    """Extrai o (único) link de redefinição do corpo sem nunca imprimi-lo."""
    links = [w for w in text.split() if w.startswith(f"{ORIGIN}/redefinir-senha")]
    assert len(links) == 1, "o corpo deve conter exatamente um link de redefinição"
    return urllib.parse.urlsplit(links[0])


def local_fmt(moment: datetime) -> str:
    return moment.astimezone(ZoneInfo(TZ)).strftime("%d/%m/%Y %H:%M") + f" ({TZ})"


@pytest.fixture
def no_leftover_children():
    yield
    assert live_children() == 0, "processo filho SMTP restante depois do teste"


# ------------------------------------------------------------------ caminho feliz
def test_conta_existente_recebe_e_inexistente_nao_com_resposta_neutra(pg_app, pg_schema, mailpit,
                                                                       no_leftover_children):
    box, target = mailpit
    app = pg_app(**smtp_env(target))
    with TestClient(app) as client:
        register(client)
        existing = post_forgot(client)
        missing = post_forgot(client, "ninguem@exemplo.com")
        drain(app)
        assert box.wait_count(1) == 1
    assert existing.status_code == missing.status_code == 202
    assert existing.content == missing.content and existing.json() == GENERIC
    assert len(box.messages_to(EMAIL)) == 1
    assert box.messages_to("ninguem@exemplo.com") == []                # nenhuma mensagem para inexistente
    assert dispatcher(app).counter("unknown_user") == 1
    assert dispatcher(app).counter("delivery_accepted") == 1


def test_caminho_publico_sem_banco_e_sem_esperar_o_smtp(pg_app, mailpit, no_leftover_children):
    """O 202 volta com o envio SMTP RETIDO por um gate (o worker está dentro de `send`); dentro do contexto
    da requisição, nenhum engine, conexão ou envio é tocado."""
    box, target = mailpit
    in_request: contextvars.ContextVar[bool] = contextvars.ContextVar("in_request", default=False)
    touched: list[str] = []
    app = pg_app(MAINTENANCE_OPPORTUNISTIC_ENABLED="false", **smtp_env(target))

    @app.middleware("http")
    async def mark(request, call_next):
        token = in_request.set(request.url.path.endswith("/forgot-password"))
        try:
            return await call_next(request)
        finally:
            in_request.reset(token)

    for label, engine in (("api", app.state.auth.engine), ("worker", app.state.recovery.worker_engine)):
        for name in ("connect", "checkout"):
            event.listen(engine.pool, name, lambda *a, _l=f"{label}:{name}": touched.append(_l)
                         if in_request.get() else None)
        event.listen(engine, "before_cursor_execute", lambda *a, _l=f"{label}:sql", **k: touched.append(_l)
                     if in_request.get() else None)
    transport = transport_of(app)
    original_send = transport.send
    entered, release = threading.Event(), threading.Event()

    def gated_send(message):
        if in_request.get():
            touched.append("smtp")
        entered.set()
        assert release.wait(WAIT), "teste travou esperando release"
        return original_send(message)

    transport.send = gated_send
    try:
        with TestClient(app) as client:
            register(client)
            first = post_forgot(client)
            assert entered.wait(WAIT)                                  # worker no envio, retido pelo gate
            second = post_forgot(client, "ninguem@exemplo.com")         # responde com o SMTP retido
            assert first.status_code == second.status_code == 202
            assert box.count() == 0                                    # nada enviado ainda
            release.set()
            drain(app)
            assert box.wait_count(1) == 1
    finally:
        release.set()
    assert touched == []


def test_mensagem_remetente_origem_fragmento_instantes_e_hash(pg_app, pg_schema, mailpit, no_leftover_children):
    box, target = mailpit
    app = pg_app(DEADLINES_TIMEZONE=TZ, **smtp_env(target))
    with TestClient(app) as client:
        register(client)
        assert post_forgot(client).status_code == 202
        drain(app)
        assert box.wait_count(1) == 1
    (msg,) = box.messages_to(EMAIL)
    assert msg.from_address == FROM_ADDRESS and msg.from_name == FROM_NAME
    assert msg.to == (EMAIL,) and msg.subject == "PrazoAI: redefinição de senha"
    link = reset_link_parts(msg.text)
    assert f"{link.scheme}://{link.netloc}" == ORIGIN                 # origem CONFIGURADA, nunca Host
    assert link.path == "/redefinir-senha" and link.query == ""        # token fora do caminho e da query
    token = link.fragment
    assert token and token not in link.path and token not in link.query
    with pg_schema.connect() as c:
        row = c.execute(select(password_reset_tokens)).one()
        dump = " ".join(str(v) for v in c.execute(select(password_reset_tokens)).one())
    assert row.token_hash == hash_opaque_token(token) and token not in dump   # só o hash no banco
    assert f"Gerado em: {local_fmt(row.created_at)}" in msg.text            # instantes PERSISTIDOS
    assert f"Válido até: {local_fmt(row.expires_at)}" in msg.text
    assert "apenas o link gerado por último funciona" in msg.text


def test_token_recebido_redefine_senha_e_revoga_sessoes(pg_app, pg_schema, mailpit, no_leftover_children):
    box, target = mailpit
    app = pg_app(**smtp_env(target))
    with TestClient(app) as client:
        session = register_and_login(client)
        assert post_forgot(client).status_code == 202
        drain(app)
        assert box.wait_count(1) == 1
        token = reset_link_parts(box.messages_to(EMAIL)[0].text).fragment
        reset = client.post(f"{API}/auth/reset-password", json={"token": token, "newPassword": NEW_PASSWORD})
        assert reset.status_code == 204 and reset.content == b""         # sem login automático
        old = client.post(f"{API}/auth/login", json={"email": EMAIL, "password": PASSWORD})
        new = client.post(f"{API}/auth/login", json={"email": EMAIL, "password": NEW_PASSWORD})
        assert old.status_code == 401 and new.status_code == 200
        assert client.get(f"{API}/auth/me", headers=bearer(session["accessToken"])).status_code == 401
        assert client.post(f"{API}/auth/refresh", json={"refreshToken": session["refreshToken"]}).status_code == 401
        again = client.post(f"{API}/auth/reset-password", json={"token": token, "newPassword": "Outra-senha-789"})
        assert again.status_code == 400                                 # consumo único
    with pg_schema.connect() as c:
        assert c.execute(select(users.c.credential_version)).scalar_one() == 1


def test_dois_pedidos_em_ordem_duas_mensagens_so_o_ultimo_token_vale(pg_app, mailpit, no_leftover_children):
    box, target = mailpit
    app = pg_app(**smtp_env(target))
    with TestClient(app) as client:
        register(client)
        assert post_forgot(client).status_code == 202
        drain(app)
        assert post_forgot(client).status_code == 202
        drain(app)
        assert box.wait_count(2) == 2
        first, second = (reset_link_parts(m.text).fragment for m in box.messages_to(EMAIL))
        assert first != second
        body = {"token": first, "newPassword": NEW_PASSWORD}
        assert client.post(f"{API}/auth/reset-password", json=body).status_code == 400   # substituído
        body["token"] = second
        assert client.post(f"{API}/auth/reset-password", json=body).status_code == 204


def test_logs_sem_token_link_corpo_ou_destinatario(pg_app, mailpit, caplog, no_leftover_children):
    box, target = mailpit
    with caplog.at_level(logging.DEBUG):
        app = pg_app(**smtp_env(target))
        with TestClient(app) as client:
            register(client)
            post_forgot(client)
            drain(app)
            assert box.wait_count(1) == 1
    token = reset_link_parts(box.messages_to(EMAIL)[0].text).fragment
    for secret in (token, EMAIL, "redefinir-senha#", PASSWORD, "Recebemos um pedido"):
        assert secret not in caplog.text
    assert "result=delivery_accepted" in caplog.text


# ------------------------------------------------------------------ falhas e limites
def test_transporte_desabilitado_503_sem_token_nem_mensagem(pg_app, pg_schema, mailpit):
    box, _ = mailpit
    app = pg_app(EMAIL_TRANSPORT="disabled")
    with TestClient(app) as client:
        register(client)
        resp = post_forgot(client)
        assert resp.status_code == 503 and resp.json()["error"]["code"] == "password_recovery_unavailable"
        assert client.get(f"{API}/auth/password-recovery/status").json() == {"available": False}
    assert box.count() == 0
    with pg_schema.connect() as c:
        assert c.execute(select(func.count()).select_from(password_reset_tokens)).scalar_one() == 0


def test_servidor_smtp_inacessivel_sem_repeticao_e_sem_prometer_entrega(pg_app, pg_schema, mailpit,
                                                                        no_leftover_children):
    """SIMULAÇÃO: porta local fechada (conexão recusada). Token emitido e confirmado (falha DEPOIS do
    COMMIT), UMA tentativa, nada no capturador; resposta pública inalterada; transporte segue disponível."""
    box, _ = mailpit
    probe = socket.socket()
    probe.bind(("127.0.0.1", 0))
    closed_port = probe.getsockname()[1]
    probe.close()
    app = pg_app(**smtp_env(("127.0.0.1", closed_port)))
    with TestClient(app) as client:
        register(client)
        assert post_forgot(client).json() == GENERIC
        drain(app)
        assert client.get(f"{API}/auth/password-recovery/status").json() == {"available": True}
    t = transport_of(app)
    assert t.spawned == 1                                              # nenhuma repetição automática
    assert dispatcher(app).counter("delivery_accepted") == 0
    assert box.count() == 0
    with pg_schema.connect() as c:
        assert c.execute(select(func.count()).select_from(password_reset_tokens)).scalar_one() == 1


def test_smtp_lento_vence_o_prazo_total_resultado_incerto_sem_repeticao(pg_app, pg_schema, mailpit, caplog,
                                                                        no_leftover_children):
    """SIMULAÇÃO controlada: servidor SMTP local que aceita a conexão e NÃO envia a saudação. O supervisor
    encerra o filho no prazo total (`deadline_killed`, entrega INCERTA), sem repetir; nada chega ao
    capturador real e o log não afirma envio."""
    from tests.smtp_test_server import ServerOptions, SmtpTestServer

    box, _ = mailpit
    hold = threading.Event()
    with SmtpTestServer(ServerOptions(hold_greeting=hold)) as slow:
        with caplog.at_level(logging.INFO):
            app = pg_app(**smtp_env(("127.0.0.1", slow.port), SMTP_TIMEOUT_SECONDS="30",
                                    SMTP_SEND_DEADLINE_SECONDS="5", SMTP_TERM_GRACE_SECONDS="0.5",
                                    SMTP_REAP_TIMEOUT_SECONDS="1"))
            with TestClient(app) as client:
                register(client)
                assert post_forgot(client).status_code == 202
                assert slow.opts.connected.wait(WAIT)                  # filho conectado e preso na saudação
                drain(app)                                             # o worker volta após o prazo total
        assert slow.opts.messages == []
    t = transport_of(app)
    assert t.spawned == 1 and dispatcher(app).counter("delivery_deadline_killed") == 1
    assert "result=delivery_deadline_killed" in caplog.text and "result=delivery_accepted" not in caplog.text
    assert box.count() == 0
    assert dispatcher(app).state is DispatcherState.STOPPED_CLEAN
    with pg_schema.connect() as c:
        assert c.execute(select(func.count()).select_from(password_reset_tokens)).scalar_one() == 1


def test_nenhum_filho_ou_worker_restante_apos_encerramento(pg_app, mailpit):
    box, target = mailpit
    app = pg_app(**smtp_env(target))
    with TestClient(app) as client:
        register(client)
        for _ in range(3):
            assert post_forgot(client).status_code == 202
        drain(app)
        assert box.wait_count(3) == 3
    assert dispatcher(app).state is DispatcherState.STOPPED_CLEAN
    assert live_children() == 0
    assert not any(th.name == WORKER_THREAD_NAME for th in threading.enumerate())
    assert transport_of(app).spawned == 3                              # um filho por pedido, nenhum extra
