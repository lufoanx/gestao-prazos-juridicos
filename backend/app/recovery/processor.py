"""Processamento de UM pedido de recuperação, executado SOMENTE pelo worker do despachante.

Etapas (a parada é verificada antes de cada uma, por `enter`):
1. `lookup`  — busca o usuário pelo e-mail normalizado (inexistente → descarta, `unknown_user`);
2. `issue`   — gera o token e usa a emissão atômica existente (`issue_replacing_active`: bloqueio,
               relógio pós-lock, expiração persistida, COMMIT). Só o HASH vai ao banco;
3. `deliver` — DEPOIS do COMMIT: monta a mensagem com os instantes PERSISTIDOS e faz UMA tentativa
               de entrega. Nenhuma conexão SQL fica aberta durante o envio.
Nenhuma repetição automática. Logs só com categoria, `user_id` e o id aleatório do pedido.
"""
from __future__ import annotations

import logging
from collections.abc import Callable
from datetime import timedelta

from app.core.clock import Clock
from app.core.errors import ConcurrentUpdateError
from app.domain.auth import PasswordResetToken
from app.email.message import SendResult
from app.repositories.auth import PasswordResetRepository, UserRepository
from app.security.tokens import hash_opaque_token, new_opaque_token
from app.services.password_reset_delivery import PasswordResetDelivery, PasswordResetMessage

logger = logging.getLogger("prazoai.recovery")

#: `enter(etapa)` publica a etapa e devolve False se a parada já foi pedida (nada novo começa).
EnterStage = Callable[[str], bool]


class RecoveryProcessor:
    def __init__(self, *, users: UserRepository, resets: PasswordResetRepository, clock: Clock,
                 reset_ttl_seconds: int, delivery: PasswordResetDelivery) -> None:
        self._users = users
        self._resets = resets
        self._clock = clock
        self._ttl = timedelta(seconds=reset_ttl_seconds)
        self._delivery = delivery

    def process(self, email: str, enter: EnterStage) -> str:
        """Devolve a categoria do resultado (para contadores e log)."""
        if not enter("lookup"):
            return "stopped"
        try:
            user = self._users.get_by_email(email)
        except Exception as exc:                             # só a classe; nunca a mensagem
            return _failure("lookup_failed", exc)
        if user is None:
            return "unknown_user"
        if not enter("issue"):
            return "stopped"
        token = new_opaque_token()
        now = self._clock.now()                              # provisório; o persistido vem pós-lock
        record = PasswordResetToken(token_hash=hash_opaque_token(token), user_id=user.id, created_at=now,
                                    expires_at=now + self._ttl)
        try:
            issued = self._resets.issue_replacing_active(record, now)
        except ConcurrentUpdateError:
            return "issue_conflict"
        except Exception as exc:
            return _failure("issue_failed", exc)
        # COMMIT confirmado. Corrida documentada: parada reconhecida aqui deixa um token não enviado,
        # que expira e é removido pela manutenção (P5).
        if not enter("deliver"):
            logger.info("recovery_issued_not_sent user_id=%s", user.id)
            return "stopped_after_issue"
        message = PasswordResetMessage(user.id, user.email, token, issued.expires_at, issued.created_at)
        try:
            result = self._delivery.send(message)            # UMA tentativa, sem repetição
        except Exception as exc:
            return _failure("delivery_failed", exc)
        if isinstance(result, SendResult):
            return f"delivery_{result.value}"
        return "delivery_handed_off"


def _failure(category: str, exc: BaseException) -> str:
    logger.warning("recovery_stage_failed category=%s error=%s", category, type(exc).__name__)
    return category
