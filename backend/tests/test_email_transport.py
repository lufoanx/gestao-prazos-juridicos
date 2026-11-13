"""E1 — transporte SMTP em subprocesso supervisionado e transporte desabilitado.

REAIS: o filho de verdade (`app/email/smtp_child.py`) conversa com um servidor SMTP LOCAL controlado
(`tests/smtp_test_server.py`, só 127.0.0.1), com TLS e certificados reais de uma CA de teste.
SIMULAÇÕES (identificadas em cada teste): criação lenta (popen embrulhado), falha de coleta (processo
dublê), filhos de teste (`tests/email_children/`). Nenhum provedor externo é contatado.
"""
from __future__ import annotations

import logging
import os
import subprocess
import sys
import threading
import time
from dataclasses import replace
from pathlib import Path

import pytest

from app.email.config import EmailConfig
from app.email.message import OutgoingEmail, SendResult
from tests.smtp_test_server import ServerOptions, SmtpTestServer, make_certs

pytestmark = pytest.mark.skipif(not sys.platform.startswith("linux"), reason="transporte SMTP só em Linux")
CHILDREN = Path(__file__).resolve().parent / "email_children"
PASSWORD = "senha-smtp-ficticia-9f8e7d"
TOKEN = "TokenFicticio_0123456789abcdefghij"
MSG = OutgoingEmail(to="ana@exemplo.com", subject="PrazoAI: redefinição de senha",
                    text=f"Link: https://app.exemplo.com/redefinir-senha#{TOKEN}\n")


def config(port: int, **over) -> EmailConfig:
    base = dict(origin="https://app.exemplo.com", from_display="PrazoAI", from_address="nao-responda@exemplo.com",
                smtp_host="127.0.0.1", smtp_port=port, security="none", username=None, password=None, ca_file=None,
                timeout_seconds=5, send_deadline_seconds=10, term_grace_seconds=0.5, reap_timeout_seconds=1)
    base.update(over)
    return EmailConfig(**base)


def transport(cfg, **kw):
    from app.email.smtp_subprocess import SubprocessSmtpTransport

    return SubprocessSmtpTransport(cfg, **kw)


class Capture:
    """Embrulha o Popen real para observar o filho criado (pid, código de saída)."""

    def __init__(self, before=None):
        self.children: list[subprocess.Popen] = []
        self.before = before

    def __call__(self, *a, **kw):
        if self.before:
            self.before()
        p = subprocess.Popen(*a, **kw)
        self.children.append(p)
        return p


def live_children() -> int:
    me = os.getpid()
    n = 0
    for d in Path("/proc").iterdir():
        if d.name.isdigit():
            try:
                fields = (d / "stat").read_text().rsplit(")", 1)[1].split()
                if int(fields[1]) == me and fields[0] != "Z":
                    n += 1
            except (OSError, IndexError, ValueError):
                pass
    return n


@pytest.fixture(scope="module")
def certs(tmp_path_factory):
    return make_certs(tmp_path_factory.mktemp("certs"))


# ---------------------------------------------------------------- reais: sucesso, recusa, autenticação
def test_real_aceito_em_servidor_local_sem_tls_na_excecao_aprovada():
    with SmtpTestServer(ServerOptions()) as srv:
        r = transport(config(srv.port)).send(MSG)
    assert r is SendResult.ACCEPTED
    import email
    from email.policy import default

    parsed = email.message_from_bytes(srv.opts.messages[0], policy=default)
    assert f"redefinir-senha#{TOKEN}" in parsed.get_content()
    assert parsed["To"] == "ana@exemplo.com" and parsed["From"] == "PrazoAI <nao-responda@exemplo.com>"
    assert parsed["Subject"] == "PrazoAI: redefinição de senha"


def test_real_destinatario_recusado():
    with SmtpTestServer(ServerOptions(refuse_rcpt={"ana@exemplo.com"})) as srv:
        assert transport(config(srv.port)).send(MSG) is SendResult.REFUSED
    assert srv.opts.messages == []


def test_real_starttls_com_ca_de_teste_e_autenticacao(certs):
    opts = ServerOptions(advertise_starttls=True, cert=certs["good"], auth=("u", PASSWORD))
    with SmtpTestServer(opts) as srv:
        cfg = config(srv.port, smtp_host="localhost", security="starttls", ca_file=certs["ca"],
                     username="u", password=PASSWORD)
        assert transport(cfg).send(MSG) is SendResult.ACCEPTED
        bad = replace(cfg, password="errada")
        assert transport(bad).send(MSG) is SendResult.AUTH_ERROR
    assert len(srv.opts.messages) == 1


def test_real_tls_implicito(certs):
    with SmtpTestServer(ServerOptions(implicit_tls=True, cert=certs["good"])) as srv:
        cfg = config(srv.port, smtp_host="localhost", security="tls", ca_file=certs["ca"])
        assert transport(cfg).send(MSG) is SendResult.ACCEPTED


# ---------------------------------------------------------------- reais: TLS obrigatório
def test_real_certificado_nao_confiavel_recusado(certs):
    with SmtpTestServer(ServerOptions(advertise_starttls=True, cert=certs["good"])) as srv:
        cfg = config(srv.port, smtp_host="localhost", security="starttls")   # sem a CA de teste
        assert transport(cfg).send(MSG) is SendResult.TLS_ERROR
    assert srv.opts.messages == []


def test_real_nome_do_certificado_divergente_recusado(certs):
    with SmtpTestServer(ServerOptions(advertise_starttls=True, cert=certs["wrong"])) as srv:
        cfg = config(srv.port, smtp_host="localhost", security="starttls", ca_file=certs["ca"])
        assert transport(cfg).send(MSG) is SendResult.TLS_ERROR
    assert srv.opts.messages == []


def test_real_sem_starttls_anunciado_nao_ha_downgrade():
    with SmtpTestServer(ServerOptions(advertise_starttls=False)) as srv:
        cfg = config(srv.port, security="starttls")
        assert transport(cfg).send(MSG) is SendResult.TLS_ERROR
    assert srv.opts.messages == []                                         # nada enviado em claro


# ---------------------------------------------------------------- reais: tempo
def test_real_timeout_por_operacao_dentro_do_filho():
    hold = threading.Event()
    with SmtpTestServer(ServerOptions(hold_greeting=hold)) as srv:
        cfg = config(srv.port, timeout_seconds=0.5, send_deadline_seconds=10)
        r = transport(cfg).send(MSG)
    assert r is SendResult.TIMEOUT                                          # o filho desistiu sozinho


def test_real_prazo_total_mata_o_filho_e_coleta(certs):
    """Vencimento DURANTE a negociação TLS (o servidor responde 220 ao STARTTLS e trava)."""
    stall = threading.Event()
    cap = Capture()
    opts = ServerOptions(advertise_starttls=True, cert=certs["good"], stall_starttls=stall)
    with SmtpTestServer(opts) as srv:
        cfg = config(srv.port, smtp_host="localhost", security="starttls", ca_file=certs["ca"], timeout_seconds=30,
                     send_deadline_seconds=1)
        t0 = time.monotonic()
        r = transport(cfg, popen=cap).send(MSG)
        took = time.monotonic() - t0
    assert r is SendResult.DEADLINE_KILLED
    assert cap.children[0].returncode is not None                          # coletado
    assert took < 1 + 0.5 + 1 + 2                                          # prazo + TERM + coleta + folga


def test_real_segredos_fora_de_argumentos_e_ambiente_do_filho(caplog):
    hold = threading.Event()
    cap = Capture()
    seen = {}
    with SmtpTestServer(ServerOptions(hold_greeting=hold)) as srv:
        t = transport(config(srv.port, security="none"), popen=cap)
        with caplog.at_level(logging.DEBUG):
            runner = threading.Thread(target=lambda: seen.setdefault("r", t.send(MSG)))
            runner.start()
            assert srv.opts.connected.wait(10)                             # filho conectado e esperando
            pid = cap.children[0].pid
            seen["cmdline"] = Path(f"/proc/{pid}/cmdline").read_bytes()
            seen["environ"] = Path(f"/proc/{pid}/environ").read_bytes()
            hold.set()
            runner.join(15)
    assert seen["r"] is SendResult.ACCEPTED
    for blob in (seen["cmdline"], seen["environ"]):
        assert TOKEN.encode() not in blob and b"ana@exemplo.com" not in blob
    assert b"DATABASE_URL" not in seen["environ"] and b"SMTP_PASSWORD" not in seen["environ"]
    assert seen["cmdline"].split(b"\0")[1] == b"-I"                         # interpretador isolado, sem shell
    assert TOKEN not in caplog.text and "ana@exemplo.com" not in caplog.text


def test_real_senha_nunca_em_argumentos_ambiente_ou_logs(certs, caplog):
    hold = threading.Event()
    cap = Capture()
    blobs = []
    opts = ServerOptions(advertise_starttls=True, cert=certs["good"], auth=("u", PASSWORD), hold_greeting=hold)
    with SmtpTestServer(opts) as srv:
        cfg = config(srv.port, smtp_host="localhost", security="starttls", ca_file=certs["ca"], username="u",
                     password=PASSWORD)
        t = transport(cfg, popen=cap)
        out = {}
        with caplog.at_level(logging.DEBUG):
            th = threading.Thread(target=lambda: out.setdefault("r", t.send(MSG)))
            th.start()
            assert srv.opts.connected.wait(10)
            pid = cap.children[0].pid
            blobs += [Path(f"/proc/{pid}/cmdline").read_bytes(), Path(f"/proc/{pid}/environ").read_bytes()]
            hold.set()
            th.join(15)
    assert out["r"] is SendResult.ACCEPTED
    assert all(PASSWORD.encode() not in b for b in blobs) and PASSWORD not in caplog.text


# ---------------------------------------------------------------- simulações: filhos de teste
def test_simulacao_filho_ignora_term_e_recebe_kill():
    cap = Capture()
    t = transport(config(1, send_deadline_seconds=0.3, term_grace_seconds=0.3), popen=cap,
                  script=CHILDREN / "ignore_term.py")
    assert t.send(MSG) is SendResult.DEADLINE_KILLED
    assert cap.children[0].returncode == -9                                # escalonou para SIGKILL e coletou
    assert t.available is True                                             # coletado: segue disponível


@pytest.mark.parametrize("script", ["bad_output.py", "exit_nonzero.py"])
def test_simulacao_saida_invalida_do_filho(script):
    t = transport(config(1), script=CHILDREN / script)
    assert t.send(MSG) is SendResult.INVALID_OUTPUT


def test_simulacao_falha_de_coleta_torna_o_transporte_indisponivel():
    """Dublê: processo cuja espera nunca confirma o término (a coleta falha)."""
    real = subprocess.Popen([sys.executable, str(CHILDREN / "ignore_term.py")], start_new_session=True,
                            stdin=subprocess.PIPE, stdout=subprocess.PIPE)

    class NeverReaped:
        pid, stdin, stdout, returncode = real.pid, real.stdin, real.stdout, None

        def communicate(self, data, timeout):
            raise subprocess.TimeoutExpired("filho", timeout)

        def poll(self):
            return None

        def wait(self, timeout):
            raise subprocess.TimeoutExpired("filho", timeout)

    calls = []

    def popen(*a, **kw):
        calls.append(1)
        return NeverReaped()

    try:
        t = transport(config(1, send_deadline_seconds=0.2, term_grace_seconds=0.1, reap_timeout_seconds=0.1),
                      popen=popen)
        assert t.send(MSG) is SendResult.UNAVAILABLE and t.available is False
        assert t.send(MSG) is SendResult.UNAVAILABLE                       # nenhum novo filho
        assert len(calls) == 1
    finally:
        real.kill()
        real.wait(5)


def test_simulacao_criacao_lenta_e_cancelamento_antes_da_publicacao():
    """Dublê: a criação fica retida; `cancel()` não espera o lock nem a criação; o filho criado depois
    é encerrado ANTES de receber a mensagem."""
    gate, entered = threading.Event(), threading.Event()

    def slow():
        entered.set()
        assert gate.wait(10)

    cap = Capture(before=slow)
    with SmtpTestServer(ServerOptions()) as srv:
        t = transport(config(srv.port), popen=cap)
        out = {}
        th = threading.Thread(target=lambda: out.setdefault("r", t.send(MSG)))
        th.start()
        assert entered.wait(10)                                            # dentro de Popen (fora do lock)
        t0 = time.monotonic()
        t.cancel()                                                         # não bloqueia
        assert time.monotonic() - t0 < 0.5
        gate.set()
        th.join(15)
    assert out["r"] is SendResult.CANCELLED
    assert srv.opts.messages == [] and cap.children[0].returncode is not None   # nada transmitido; coletado
    assert t.available is False                                            # parado


def test_simulacao_cancelamento_com_filho_publicado():
    hold = threading.Event()
    cap = Capture()
    with SmtpTestServer(ServerOptions(hold_greeting=hold)) as srv:
        t = transport(config(srv.port), popen=cap)
        out = {}
        th = threading.Thread(target=lambda: out.setdefault("r", t.send(MSG)))
        th.start()
        assert srv.opts.connected.wait(10)
        t.cancel()
        th.join(15)
    assert out["r"] is SendResult.CANCELLED and cap.children[0].returncode is not None
    assert srv.opts.messages == []


def test_sem_repeticao_e_sem_crescimento_de_processos():
    base = live_children()
    cap = Capture()
    t = transport(config(1, send_deadline_seconds=0.3, term_grace_seconds=0.2), popen=cap,
                  script=CHILDREN / "ignore_term.py")
    results = [t.send(MSG) for _ in range(3)]
    assert results == [SendResult.DEADLINE_KILLED] * 3 and len(cap.children) == 3   # 1 filho por chamada
    assert all(p.returncode is not None for p in cap.children)
    assert live_children() == base                                         # nenhum processo sobrando


def test_falha_ao_criar_o_filho():
    def popen(*a, **kw):
        raise OSError("sem recursos")

    t = transport(config(1), popen=popen)
    assert t.send(MSG) is SendResult.SPAWN_FAILED and t.available is True


# ---------------------------------------------------------------- desabilitado e plataforma
def test_desabilitado_nao_cria_subprocesso_nem_importa_recursos_linux():
    from app.core.config import Settings
    from app.email.transport import DisabledTransport, build_email_transport

    t = build_email_transport(Settings(_env_file=None))
    assert isinstance(t, DisabledTransport) and t.available is False
    assert t.send(MSG) is SendResult.UNAVAILABLE
    script = ("import sys; from app.core.config import Settings; "
              "from app.email.transport import build_email_transport; "
              "build_email_transport(Settings(_env_file=None)); "
              "print('app.email.smtp_subprocess' in sys.modules, 'resource' in sys.modules, 'signal' in sys.modules)")
    out = subprocess.run([sys.executable, "-c", script], cwd=Path(__file__).resolve().parents[1], capture_output=True,
                         text=True, timeout=60, env={"PATH": os.environ.get("PATH", "")})
    assert out.stdout.strip().split()[:2] == ["False", "False"], out.stderr[-300:]


@pytest.mark.parametrize("patch", ["platform", "killpg"])
def test_plataforma_nao_suportada_recusa_smtp_e_aceita_desabilitado(monkeypatch, patch):
    from app.core.config import Settings
    from app.email import smtp_subprocess
    from app.email.transport import DisabledTransport, UnsupportedPlatformError, build_email_transport

    if patch == "platform":
        monkeypatch.setattr(smtp_subprocess.sys, "platform", "win32")
    else:
        monkeypatch.delattr(smtp_subprocess.os, "killpg")
    smtp = Settings(_env_file=None, EMAIL_TRANSPORT="smtp", PUBLIC_APP_ORIGIN="https://app.exemplo.com",
                    EMAIL_FROM="nao-responda@exemplo.com", SMTP_HOST="smtp.exemplo.com")
    with pytest.raises(UnsupportedPlatformError):
        build_email_transport(smtp)
    assert isinstance(build_email_transport(Settings(_env_file=None)), DisabledTransport)


def test_filho_nao_importa_a_aplicacao_nem_logging():
    import ast

    tree = ast.parse((Path(__file__).resolve().parents[1] / "app" / "email" / "smtp_child.py").read_text())
    names = {a.name.split(".")[0] for n in ast.walk(tree) if isinstance(n, ast.Import) for a in n.names}
    names |= {n.module.split(".")[0] for n in ast.walk(tree) if isinstance(n, ast.ImportFrom) and n.module}
    assert "app" not in names and "logging" not in names and "sqlalchemy" not in names
