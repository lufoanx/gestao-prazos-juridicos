"""Contrato do transporte de e-mail, transporte desabilitado e montagem a partir da configuração."""
from __future__ import annotations

from typing import Protocol

from app.email.message import OutgoingEmail, SendResult


class EmailTransport(Protocol):
    @property
    def available(self) -> bool: ...

    def send(self, message: OutgoingEmail) -> SendResult: ...

    def cancel(self, timeout: float | None = None) -> bool:
        """Pede a parada coordenada (inclusive de um filho em criação); idempotente.

        `timeout` limita a espera TOTAL desta chamada, desde a entrada (lock incluído). True só com
        confirmação de que não há filho ativo."""
        ...

    def unconfirmed_child(self, timeout: float) -> bool | None:
        """Filho em criação ou sem coleta confirmada; None se não for possível confirmar no prazo."""
        ...


class DisabledTransport:
    """Padrão: nada é enviado e nenhum subprocesso é criado; funciona em qualquer plataforma."""

    available = False
    has_unconfirmed_child = False

    def send(self, message: OutgoingEmail) -> SendResult:
        return SendResult.UNAVAILABLE

    def cancel(self, timeout: float | None = None) -> bool:
        return True

    def unconfirmed_child(self, timeout: float) -> bool | None:
        return False


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
