"""Relógio injetável (UTC). Permite testar expiração sem `sleep`."""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Protocol


class Clock(Protocol):
    def now(self) -> datetime:
        """Instante atual, sempre com fuso UTC."""
        ...


class SystemClock:
    def now(self) -> datetime:
        return datetime.now(timezone.utc)
