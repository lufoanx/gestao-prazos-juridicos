"""Mensagem a enviar e categorias de resultado (sem conteúdo em `repr`)."""
from __future__ import annotations

from dataclasses import dataclass
from enum import Enum


@dataclass(frozen=True)
class OutgoingEmail:
    to: str
    subject: str
    text: str

    def __repr__(self) -> str:                 # nunca exibe destinatário, assunto nem corpo (link/token)
        return "OutgoingEmail(<oculto>)"


class SendResult(str, Enum):
    """Resultado de UMA tentativa (sem repetição automática)."""

    ACCEPTED = "accepted"              # aceito pelo servidor SMTP (≠ entregue na caixa)
    REFUSED = "refused"                # remetente/destinatário/dados recusados
    AUTH_ERROR = "auth_error"
    TLS_ERROR = "tls_error"            # falha de TLS, certificado ou STARTTLS ausente (sem downgrade)
    TIMEOUT = "timeout"                # timeout de uma operação dentro do filho
    ERROR = "error"                    # outra falha dentro do filho
    DEADLINE_KILLED = "deadline_killed"  # prazo do supervisor vencido; entrega INCERTA
    INVALID_OUTPUT = "invalid_output"  # filho saiu sem uma categoria conhecida
    SPAWN_FAILED = "spawn_failed"      # não foi possível criar o filho
    CANCELLED = "cancelled"            # parada solicitada; entrega incerta se o filho já tinha começado
    UNAVAILABLE = "unavailable"        # transporte desabilitado ou indisponível (ex.: falha de coleta)


#: Categorias que o FILHO pode escrever na saída padrão; qualquer outra coisa é `invalid_output`.
CHILD_CATEGORIES = frozenset({"accepted", "refused", "auth_error", "tls_error", "timeout", "error"})
