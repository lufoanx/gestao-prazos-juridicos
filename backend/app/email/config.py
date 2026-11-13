"""Validação da configuração de e-mail (só a FORMA; plataforma é checada no transporte).

Regras (doc 21, §5 e §7):
- PUBLIC_APP_ORIGIN: fixa e validada (só esquema + host + porta), nunca derivada de Host; `https`
  obrigatório, exceto loopback em development/test;
- EMAIL_FROM: um único endereço válido, sem CR/LF;
- SMTP_SECURITY: `starttls` (padrão) ou `tls`; `none` só com SMTP_ALLOW_INSECURE_LOCAL=true, host de
  loopback e ENVIRONMENT development/test (exceção local aprovada), e sem credenciais;
- credenciais: usuário e senha juntos, ou nenhum.
Mensagens de erro nunca exibem a senha.
"""
from __future__ import annotations

import ipaddress
from dataclasses import dataclass
from email.utils import parseaddr
from urllib.parse import urlsplit

from email_validator import EmailNotValidError, validate_email

LOOPBACK_HOSTS = frozenset({"localhost", "127.0.0.1", "::1"})
SECURITY_MODES = frozenset({"starttls", "tls", "none"})


class EmailConfigError(ValueError):
    pass


def _no_controls(value: str, name: str) -> None:
    if any(ch in value for ch in ("\r", "\n", "\x00")):
        raise EmailConfigError(f"{name} contém caracteres de controle.")


def validate_origin(raw: str | None, environment: str) -> str:
    if not raw:
        raise EmailConfigError("PUBLIC_APP_ORIGIN é obrigatória com EMAIL_TRANSPORT=smtp.")
    _no_controls(raw, "PUBLIC_APP_ORIGIN")
    parts = urlsplit(raw)
    if parts.scheme not in ("http", "https") or not parts.hostname:
        raise EmailConfigError("PUBLIC_APP_ORIGIN deve ser uma origem http(s) completa.")
    if parts.username or parts.password or parts.path not in ("", "/") or parts.query or parts.fragment:
        raise EmailConfigError("PUBLIC_APP_ORIGIN deve conter só esquema, host e porta.")
    try:
        parts.port                                          # valida a porta
    except ValueError:
        raise EmailConfigError("PUBLIC_APP_ORIGIN tem porta inválida.") from None
    loopback = parts.hostname in LOOPBACK_HOSTS
    if parts.scheme == "http" and not (loopback and environment in {"development", "test"}):
        raise EmailConfigError("PUBLIC_APP_ORIGIN exige https (http só em loopback, em development/test).")
    return f"{parts.scheme}://{parts.netloc}"


def validate_address(raw: str | None, name: str) -> tuple[str, str]:
    """Devolve (nome de exibição, endereço normalizado)."""
    if not raw:
        raise EmailConfigError(f"{name} é obrigatório.")
    _no_controls(raw, name)
    display, address = parseaddr(raw)
    if raw.count("@") != 1 or not address or "," in address:
        raise EmailConfigError(f"{name} deve conter exatamente um endereço.")
    try:
        normalized = validate_email(address, check_deliverability=False).normalized
    except EmailNotValidError:
        raise EmailConfigError(f"{name} não é um endereço válido.") from None
    return display, normalized


def _is_loopback(host: str) -> bool:
    if host in LOOPBACK_HOSTS:
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


@dataclass(frozen=True)
class EmailConfig:
    origin: str
    from_display: str
    from_address: str
    smtp_host: str
    smtp_port: int
    security: str
    username: str | None
    password: str | None
    ca_file: str | None
    timeout_seconds: float
    send_deadline_seconds: float
    term_grace_seconds: float
    reap_timeout_seconds: float

    def __repr__(self) -> str:
        return f"EmailConfig(host={self.smtp_host!r}, port={self.smtp_port}, security={self.security!r})"

    @classmethod
    def from_settings(cls, s) -> EmailConfig:
        origin = validate_origin(s.public_app_origin, s.environment)
        display, address = validate_address(s.email_from, "EMAIL_FROM")
        host = (s.smtp_host or "").strip()
        if not host:
            raise EmailConfigError("SMTP_HOST é obrigatório com EMAIL_TRANSPORT=smtp.")
        _no_controls(host, "SMTP_HOST")
        if any(c.isspace() for c in host):
            raise EmailConfigError("SMTP_HOST inválido.")
        security = (s.smtp_security or "").strip().lower()
        if security not in SECURITY_MODES:
            raise EmailConfigError("SMTP_SECURITY inválido: use 'starttls', 'tls' ou 'none'.")
        username = s.smtp_username or None
        password = s.smtp_password.get_secret_value() if s.smtp_password else None
        if (username is None) != (password is None):
            raise EmailConfigError("SMTP_USERNAME e SMTP_PASSWORD devem ser informados juntos.")
        if username is not None:
            _no_controls(username, "SMTP_USERNAME")
        if security == "none":
            if not s.smtp_allow_insecure_local:
                raise EmailConfigError("SMTP_SECURITY=none exige SMTP_ALLOW_INSECURE_LOCAL=true.")
            if not _is_loopback(host):
                raise EmailConfigError("SMTP_SECURITY=none só é aceito com servidor local (loopback).")
            if s.environment not in {"development", "test"}:
                raise EmailConfigError("SMTP_SECURITY=none só é aceito em development ou test.")
            if username is not None:
                raise EmailConfigError("Credenciais SMTP exigem TLS (não use SMTP_SECURITY=none).")
        if s.smtp_ca_file is not None:
            _no_controls(s.smtp_ca_file, "SMTP_CA_FILE")
        return cls(origin=origin, from_display=display, from_address=address, smtp_host=host,
                   smtp_port=s.smtp_port, security=security, username=username, password=password,
                   ca_file=s.smtp_ca_file, timeout_seconds=s.smtp_timeout_seconds,
                   send_deadline_seconds=s.smtp_send_deadline_seconds,
                   term_grace_seconds=s.smtp_term_grace_seconds, reap_timeout_seconds=s.smtp_reap_timeout_seconds)
