"""Comando explícito de manutenção (P5).

    python -m app.maintenance purge [--max-batches N] [--batch-size N]

Valida tudo ANTES de apagar: produção recusada; STORAGE=postgres obrigatório (em `memory` o estado
pertence a cada processo e o comando NÃO finge limpá-lo); só o destino de DATABASE_URL (sem
fallback); revisão do esquema exigida, verificada SOMENTE LEITURA (migrations nunca rodam aqui).
Não importa a aplicação web (nenhum container, rota ou engine duplicado). O engine é fechado em
qualquer saída. Saída em JSON, só com contagens CONFIRMADAS.

Códigos de saída:
  0  concluído: todas as categorias visitadas e esgotadas (exceto linhas bloqueadas, `skippedLocked`)
  6  PARCIAL: o limite de trabalho acabou antes (`limitReached`); restam pendências para outra execução
  1  interrompido por falha (lock_timeout, deadlock, statement_timeout, erro); lotes anteriores confirmados
  2  configuração inválida (inclui ENVIRONMENT=production e DATABASE_URL ausente/inválida)
  3  STORAGE=memory: nada a fazer pelo comando (o estado em memória é de cada processo)
  4  esquema ausente ou em revisão diferente da exigida (nada foi apagado)
  5  banco indisponível ou erro ao verificar o esquema (nada foi apagado)
"""
from __future__ import annotations

import argparse
import json
import logging
import sys

EXIT_OK, EXIT_INTERRUPTED, EXIT_CONFIG, EXIT_MEMORY, EXIT_SCHEMA, EXIT_UNAVAILABLE, EXIT_PARTIAL = 0, 1, 2, 3, 4, 5, 6


def _emit(payload: dict) -> None:
    print(json.dumps(payload, ensure_ascii=False, sort_keys=True))


def purge(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(prog="python -m app.maintenance purge")
    parser.add_argument("--max-batches", type=int, default=None, help="limite de lotes desta execução")
    parser.add_argument("--batch-size", type=int, default=None, help="tamanho de cada lote (1–1000)")
    args = parser.parse_args(argv)

    from pydantic import ValidationError

    from app.core.config import ProductionNotReleasedError, Settings, ensure_not_production

    try:
        settings = Settings()
        ensure_not_production(settings)
    except (ValidationError, ProductionNotReleasedError) as exc:
        message = str(exc).splitlines()[0] if isinstance(exc, ProductionNotReleasedError) else "configuração inválida"
        _emit({"status": "config_error", "message": message})
        return EXIT_CONFIG
    if settings.storage != "postgres":
        _emit({"status": "memory_storage",
               "message": "STORAGE=memory: o estado em memória pertence a cada processo; nada foi limpo."})
        return EXIT_MEMORY
    if args.batch_size is not None and not 1 <= args.batch_size <= 1000:
        _emit({"status": "config_error", "message": "--batch-size deve ficar entre 1 e 1000"})
        return EXIT_CONFIG
    if args.max_batches is not None and not 1 <= args.max_batches <= 10_000:
        _emit({"status": "config_error", "message": "--max-batches deve ficar entre 1 e 10000"})
        return EXIT_CONFIG

    from app.db.config import DatabaseConfigError, database_config_from

    try:
        cfg = database_config_from(settings)
    except DatabaseConfigError as exc:
        _emit({"status": "config_error", "message": str(exc)})          # mensagens sem credenciais
        return EXIT_CONFIG

    from dataclasses import replace

    from app.core.clock import SystemClock
    from app.db.engine import create_db_engine
    from app.maintenance.purge import MaintenanceLimits, RetentionPolicy, run_maintenance
    from app.repositories.sql.schema_check import SchemaNotReadyError, ensure_schema_revision

    engine = create_db_engine(cfg, application_name="prazoai-maintenance")
    try:
        try:
            ensure_schema_revision(engine)                                # somente leitura
        except SchemaNotReadyError as exc:
            _emit({"status": "schema_not_ready", "target": cfg.describe(), "message": str(exc)})
            return EXIT_SCHEMA
        except Exception as exc:  # noqa: BLE001
            cause = getattr(exc, "orig", None) or exc
            _emit({"status": "unavailable", "target": cfg.describe(), "failure": type(cause).__name__})
            return EXIT_UNAVAILABLE
        limits = MaintenanceLimits.from_settings(settings, max_batches=args.max_batches)
        if args.batch_size is not None:
            limits = replace(limits, batch_size=args.batch_size)
        result = run_maintenance(engine, SystemClock(), RetentionPolicy.from_settings(settings), limits,
                                 operation="command")
        status = "interrupted" if result.interrupted else "partial" if result.limit_reached else "ok"
        _emit({"status": status, "target": cfg.describe(), **result.as_dict()})
        if result.interrupted:
            return EXIT_INTERRUPTED
        return EXIT_PARTIAL if result.limit_reached else EXIT_OK
    finally:
        engine.dispose()


def main(argv: list[str] | None = None) -> int:
    logging.basicConfig(level=logging.INFO, stream=sys.stderr, format="%(levelname)s %(name)s %(message)s")
    argv = list(sys.argv[1:] if argv is None else argv)
    if not argv or argv[0] != "purge":
        print("uso: python -m app.maintenance purge [--max-batches N] [--batch-size N]", file=sys.stderr)
        return EXIT_CONFIG
    return purge(argv[1:])


if __name__ == "__main__":
    sys.exit(main())
