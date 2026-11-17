"""Entrega das instruções de recuperação de senha (porta usada pelo worker do RecoveryDispatcher).

Desde a E2 (doc 21), a entrega acontece SEMPRE no worker do despachante, fora da requisição e
depois do COMMIT da emissão. Implementações:
- `TransportPasswordResetDelivery` (app/recovery/delivery.py): composer + transporte da E1 (`smtp`);
- `NoopPasswordResetDelivery`: indisponível (`available=False`); com ela a recuperação responde 503;
- nos testes, adaptadores que capturam a mensagem (injetados em `create_app`).
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
    expires_at: datetime            # expiração PERSISTIDA (relógio pós-lock)
    issued_at: datetime | None = None   # instante PERSISTIDO da emissão (E2; usado no corpo do e-mail)

    def __repr__(self) -> str:  # não vaza e-mail/token em logs
        return f"PasswordResetMessage(user_id={self.user_id!r})"


class PasswordResetDelivery(Protocol):
    """`send` devolve a categoria do resultado (ou None quando o adaptador não informa)."""

    def send(self, message: PasswordResetMessage) -> object: ...


class NoopPasswordResetDelivery:
    """Sem e-mail: nada é entregue. Indisponível — a recuperação responde 503 com este adaptador."""

    available = False

    def __init__(self) -> None:
        self._logger = get_logger("prazoai.auth")

    def send(self, message: PasswordResetMessage) -> None:
        self._logger.info("password_reset_requested delivery=noop")
