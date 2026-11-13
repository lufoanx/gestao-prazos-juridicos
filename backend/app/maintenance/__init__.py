"""Manutenção (P5): expurgo global de retenção no PostgreSQL. Ver docs/backend/20-p5-manutencao-operacao.md."""
from app.maintenance.purge import (
    AUTH_CATEGORIES,
    CATEGORIES,
    DOMAIN_CATEGORIES,
    MaintenanceLimits,
    MaintenanceResult,
    RetentionPolicy,
    run_maintenance,
)

__all__ = ["AUTH_CATEGORIES", "CATEGORIES", "DOMAIN_CATEGORIES", "MaintenanceLimits", "MaintenanceResult",
           "RetentionPolicy", "run_maintenance"]
