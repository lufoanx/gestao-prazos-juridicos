"""Configuração de logs básica, sem dados sensíveis.

Loga método, caminho e status — nunca corpos de requisição, cabeçalhos de
autenticação, tokens ou segredos.
"""
from __future__ import annotations

import logging


def configure_logging(level: str = "INFO") -> None:
    logging.basicConfig(
        level=getattr(logging, level.upper(), logging.INFO),
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )


def get_logger(name: str = "prazoai") -> logging.Logger:
    return logging.getLogger(name)
