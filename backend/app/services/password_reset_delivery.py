"""Entrega das instruções de recuperação de senha.

Esta etapa NÃO envia e-mail. A interface permite plugar um provedor real na etapa de
e-mail. O adaptador padrão apenas registra que houve um pedido — sem e-mail, sem token.
Nos testes é injetado um adaptador que captura a mensagem.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Protocol

from app.core.logging import get_logger


@dataclass(frozen=True)
class PasswordResetMessage:
    user_id: str
    email: str
    token: str  # em claro SOMENTE aqui, para o canal de entrega; nunca persistido nem logado
    expires_at: datetime

    def __repr__(self) -> str:  # não vaza e-mail/token em logs
        return f"PasswordResetMessage(user_id={self.user_id!r})"


class PasswordResetDelivery(Protocol):
    def send(self, message: PasswordResetMessage) -> None: ...


class NoopPasswordResetDelivery:
    """Padrão sem e-mail: a recuperação real depende da etapa de e-mail."""

    def __init__(self) -> None:
        self._logger = get_logger("prazoai.auth")

    def send(self, message: PasswordResetMessage) -> None:
        self._logger.info("password_reset_requested delivery=noop")
