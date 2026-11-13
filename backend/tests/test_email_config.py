"""E1 — configuração de e-mail: válidas, inválidas, origem, remetente, CR/LF, TLS e segredos."""
from __future__ import annotations

import pytest
from pydantic import ValidationError

from app.core.config import Settings
from app.email.config import EmailConfig, EmailConfigError, validate_address, validate_origin

SECRET = "senha-smtp-ficticia-9f8e7d"
BASE = {"EMAIL_TRANSPORT": "smtp", "PUBLIC_APP_ORIGIN": "https://app.exemplo.com",
        "EMAIL_FROM": "PrazoAI <nao-responda@exemplo.com>", "SMTP_HOST": "smtp.exemplo.com"}


def settings(**env):
    return Settings(_env_file=None, **env)  # type: ignore[arg-type]


def test_padrao_desabilitado_sem_exigir_nada():
    s = settings()
    assert s.email_transport == "disabled" and s.public_app_origin is None


def test_configuracao_smtp_valida():
    cfg = EmailConfig.from_settings(settings(**BASE, SMTP_USERNAME="u", SMTP_PASSWORD=SECRET))
    assert (cfg.origin, cfg.from_address, cfg.security, cfg.smtp_port) == (
        "https://app.exemplo.com", "nao-responda@exemplo.com", "starttls", 587)
    assert SECRET not in repr(cfg)


@pytest.mark.parametrize("origin, ok", [
    ("https://app.exemplo.com", True), ("https://app.exemplo.com:8443", True), ("https://app.exemplo.com/", True),
    ("http://localhost:3000", True), ("http://app.exemplo.com", False), ("https://app.exemplo.com/caminho", False),
    ("https://app.exemplo.com/?q=1", False), ("https://app.exemplo.com/#x", False),
    ("https://u:p@app.exemplo.com", False),
    ("ftp://app.exemplo.com", False), ("app.exemplo.com", False), ("https://app.exemplo.com\r\nX: y", False),
    ("https://app.exemplo.com:99999", False), ("", False),
])
def test_origem_publica(origin, ok):
    if ok:
        assert validate_origin(origin, "test").startswith(("https://", "http://localhost"))
    else:
        with pytest.raises(EmailConfigError):
            validate_origin(origin, "test")


def test_http_loopback_so_em_development_ou_test():
    assert validate_origin("http://127.0.0.1:3000", "development") == "http://127.0.0.1:3000"
    with pytest.raises(EmailConfigError):
        validate_origin("http://localhost:3000", "staging")


@pytest.mark.parametrize("raw", ["a@x.com\r\nBcc: b@y.com", "a@x.com, b@y.com", "sem-arroba", "a@@x.com",
                                 "Nome <a@x.com>\nX: y", "", "a@x"])
def test_remetente_invalido_e_injecao(raw):
    with pytest.raises(EmailConfigError):
        validate_address(raw, "EMAIL_FROM")


def test_remetente_com_nome_de_exibicao():
    expected = ("PrazoAI", "Nao-Responda@exemplo.com")
    assert validate_address("PrazoAI <Nao-Responda@Exemplo.com>", "EMAIL_FROM") == expected


@pytest.mark.parametrize("env, reason", [
    ({"SMTP_SECURITY": "none"}, "SMTP_ALLOW_INSECURE_LOCAL"),
    ({"SMTP_SECURITY": "none", "SMTP_ALLOW_INSECURE_LOCAL": "true"}, "loopback"),
    ({"SMTP_SECURITY": "none", "SMTP_ALLOW_INSECURE_LOCAL": "true", "SMTP_HOST": "localhost",
      "ENVIRONMENT": "staging", "AUTH_JWT_SECRET": "s" * 48}, "development ou test"),
    ({"SMTP_SECURITY": "none", "SMTP_ALLOW_INSECURE_LOCAL": "true", "SMTP_HOST": "127.0.0.1",
      "SMTP_USERNAME": "u", "SMTP_PASSWORD": SECRET}, "exigem TLS"),
    ({"SMTP_USERNAME": "u"}, "juntos"),
    ({"SMTP_PASSWORD": SECRET}, "juntos"),
    ({"SMTP_SECURITY": "ssl3"}, "SMTP_SECURITY"),
    ({"SMTP_HOST": ""}, "SMTP_HOST"),
    ({"SMTP_HOST": "smtp\r\n.exemplo.com"}, "SMTP_HOST"),
    ({"PUBLIC_APP_ORIGIN": "http://app.exemplo.com"}, "https"),
    ({"EMAIL_FROM": "x@y.com\r\nBcc: z@w.com"}, "EMAIL_FROM"),
])
def test_configuracoes_invalidas_recusadas_no_carregamento(env, reason):
    with pytest.raises(ValidationError) as exc:
        settings(**{**BASE, **env})
    assert reason in str(exc.value)
    assert SECRET not in str(exc.value)


def test_excecao_local_explicita_aceita():
    cfg = EmailConfig.from_settings(settings(**{**BASE, "SMTP_SECURITY": "none", "SMTP_ALLOW_INSECURE_LOCAL": "true",
                                                "SMTP_HOST": "127.0.0.1", "SMTP_PORT": "1025", "ENVIRONMENT": "test"}))
    assert (cfg.security, cfg.smtp_host, cfg.smtp_port) == ("none", "127.0.0.1", 1025)


@pytest.mark.parametrize("name, value", [("SMTP_TIMEOUT_SECONDS", "1"), ("SMTP_SEND_DEADLINE_SECONDS", "200"),
                                         ("SMTP_TERM_GRACE_SECONDS", "0"), ("SMTP_REAP_TIMEOUT_SECONDS", "0.1"),
                                         ("SMTP_PORT", "70000"), ("EMAIL_TRANSPORT", "sendgrid")])
def test_faixas_e_valores(name, value):
    with pytest.raises(ValidationError):
        settings(**{**BASE, name: value})
