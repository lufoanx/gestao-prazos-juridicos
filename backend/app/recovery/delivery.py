"""Adaptador de entrega da recuperação: composer + transporte da E1 (sem lógica própria de envio).

Usa os instantes PERSISTIDOS da emissão ("gerado em"/"válido até") e faz UMA tentativa. A
disponibilidade, o cancelamento coordenado e a confirmação de coleta do filho vêm do transporte.
"""
from __future__ import annotations

from app.email.composer import PasswordResetComposer
from app.email.message import SendResult
from app.email.transport import EmailTransport
from app.services.password_reset_delivery import PasswordResetMessage


class TransportPasswordResetDelivery:
    def __init__(self, composer: PasswordResetComposer, transport: EmailTransport) -> None:
        self._composer = composer
        self._transport = transport

    @property
    def available(self) -> bool:
        return self._transport.available

    @property
    def has_unconfirmed_child(self) -> bool:
        """Leitura sem prazo (testes/observação); o encerramento usa `unconfirmed_child(timeout)`."""
        return bool(getattr(self._transport, "has_unconfirmed_child", False))

    def unconfirmed_child(self, timeout: float) -> bool | None:
        return self._transport.unconfirmed_child(timeout)

    def cancel(self, timeout: float | None = None) -> bool:
        return self._transport.cancel(timeout=timeout)

    def send(self, message: PasswordResetMessage) -> SendResult:
        issued_at = message.issued_at if message.issued_at is not None else message.expires_at
        email = self._composer.compose(message.email, message.token, issued_at, message.expires_at)
        return self._transport.send(email)
