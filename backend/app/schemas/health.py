"""Schemas do módulo de saúde."""
from __future__ import annotations

from pydantic import BaseModel


class HealthResponse(BaseModel):
    status: str
    service: str
    # Só aparecem fora do modo padrão (memory), para preservar o contrato existente:
    storage: str | None = None      # "postgres" (P4)
    durable: bool | None = None     # True: autenticação e domínio do backend persistem (não as sessões do BFF)
