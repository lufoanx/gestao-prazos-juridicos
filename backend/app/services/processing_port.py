"""Porta de processamento de intimações (preparada para etapa futura).

Nesta etapa o adaptador padrão é `ProcessingNotAvailable`: nenhuma intimação é
processada, não há extração, OCR nem IA, e a nova tentativa responde 409
`processing_unavailable`. Adaptadores controlados existem apenas nos testes.

Contrato futuro: `request` é chamado SOMENTE depois do commit da unidade de trabalho
(nunca dentro da transação); o resultado volta por operação interna
(`IntimationService.apply_processing_result`), sem rota HTTP pública.
"""
from __future__ import annotations

from typing import Protocol


class ProcessingPort(Protocol):
    @property
    def available(self) -> bool: ...

    def request(self, intimation_id: str) -> None: ...


class ProcessingNotAvailable:
    available = False

    def request(self, intimation_id: str) -> None:  # pragma: no cover - nunca chamado
        raise RuntimeError("processamento indisponível nesta etapa")
