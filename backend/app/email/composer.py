"""Composição do e-mail de recuperação de senha (sem dados jurídicos).

Link: `<PUBLIC_APP_ORIGIN>/redefinir-senha#TOKEN` — o token vai no FRAGMENTO, que o navegador não
envia ao servidor. O corpo informa "gerado em" e "válido até" e explica que só o link gerado por
último funciona (a ordem de chegada dos e-mails não é garantida).
"""
from __future__ import annotations

import re
from datetime import datetime
from zoneinfo import ZoneInfo

from app.email.config import EmailConfigError, validate_address
from app.email.message import OutgoingEmail

TOKEN_RE = re.compile(r"^[A-Za-z0-9_-]{16,256}$")
SUBJECT = "PrazoAI: redefinição de senha"


class PasswordResetComposer:
    def __init__(self, origin: str, timezone: str = "America/Sao_Paulo") -> None:
        self._origin = origin.rstrip("/")
        self._tz = ZoneInfo(timezone)

    def link(self, token: str) -> str:
        if not TOKEN_RE.fullmatch(token):
            raise ValueError("token em formato inválido")
        return f"{self._origin}/redefinir-senha#{token}"

    def _fmt(self, moment: datetime) -> str:
        if moment.tzinfo is None:
            raise ValueError("instante sem fuso")
        local = moment.astimezone(self._tz)
        return local.strftime("%d/%m/%Y %H:%M") + f" ({self._tz.key})"

    def compose(self, recipient: str, token: str, issued_at: datetime, expires_at: datetime) -> OutgoingEmail:
        try:
            _, address = validate_address(recipient, "destinatário")
        except EmailConfigError as exc:
            raise ValueError(str(exc)) from None
        text = (
            "Recebemos um pedido para redefinir a senha da sua conta no PrazoAI.\n\n"
            f"Para escolher uma nova senha, abra o link abaixo:\n{self.link(token)}\n\n"
            f"Gerado em: {self._fmt(issued_at)}\n"
            f"Válido até: {self._fmt(expires_at)}\n\n"
            "Se você recebeu mais de um e-mail como este, apenas o link gerado por último funciona; "
            "os outros mostrarão \"link inválido ou substituído\" e você poderá pedir um novo.\n\n"
            "Se você não fez este pedido, ignore esta mensagem: sua senha continua a mesma.\n"
        )
        return OutgoingEmail(to=address, subject=SUBJECT, text=text)
