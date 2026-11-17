"""Contrato do transporte de e-mail, transporte desabilitado e montagem a partir da configuração."""
from __future__ import annotations

from typing import Protocol

from app.email.message import OutgoingEmail, SendResult


class EmailTransport(Protocol):
    @property
    def available(self) -> bool: ...

    def send(self, message: OutgoingEmail) -> SendResult: ...

    def cancel(self, timeout: float | None = None) -> None:
        """Pede a parada coordenada (inclusive de um filho em criação); idempotente.

        `timeout` limita a espera total desta chamada (E2: orçamento de desligamento)."""
        ...

    @property
    def has_unconfirmed_child(self) -> bool:
        """Verdadeiro se há filho em criação ou sem coleta confirmada."""
        ...


class DisabledTransport:
    """Padrão: nada é enviado e nenhum subprocesso é criado; funciona em qualquer plataforma."""

    available = False
    has_unconfirmed_child = False

    def send(self, message: OutgoingEmail) -> SendResult:
        return SendResult.UNAVAILABLE

    def cancel(self, timeout: float | None = None) -> None:
        return None


class UnsupportedPlatformError(RuntimeError):
    """EMAIL_TRANSPORT=smtp só é suportado em Linux nesta fase (doc 21, §4.9)."""


def build_email_transport(settings) -> EmailTransport:
    """`disabled` → DisabledTransport; `smtp` → transporte em subprocesso supervisionado (só Linux)."""
    if settings.email_transport != "smtp":
        return DisabledTransport()
    from app.email.config import EmailConfig
    from app.email.smtp_subprocess import SubprocessSmtpTransport, ensure_supported_platform

    ensure_supported_platform()
    return SubprocessSmtpTransport(EmailConfig.from_settings(settings))
