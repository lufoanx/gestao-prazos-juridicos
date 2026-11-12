"""Erros de domínio COMPARTILHADOS pelas implementações (memória e PostgreSQL) e pelos serviços.

Os serviços importam daqui, nunca das implementações em memória.
"""
from __future__ import annotations


class CapacityError(Exception):
    """Limite de crescimento atingido (verificado antes de confirmar a operação)."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


class ConsistencyError(RuntimeError):
    """Invariante violada na preparação final ou no COMMIT; a transação é descartada (erro interno)."""


class DomainConflictError(Exception):
    """Conflito de NEGÓCIO detectado pelo armazenamento sob concorrência (ex.: a pessoa entrou em
    outro escritório entre a verificação e a escrita). Vira 409 com o código informado."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


class JoinCodeCollisionError(Exception):
    """O código de ingresso gerado já está em uso; o serviço gera outro (sem abortar a transação)."""
