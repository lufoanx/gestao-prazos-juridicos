"""Comandos explícitos do armazenamento de arquivos:

    python -m app.files check              # container existe e é PRIVADO (somente leitura)
    python -m app.files create-container   # cria o container PRIVADO se faltar (nunca altera um existente)
    python -m app.files cleanup            # processa a fila de limpeza (exige STORAGE=postgres)

Códigos: 0 ok; 2 configuração; 4 container ausente/público; 5 indisponível. Sem segredos na saída.
"""
from __future__ import annotations

import sys


def main(argv: list[str]) -> int:
    cmd = argv[1:] and argv[1]
    if cmd not in {"check", "create-container", "cleanup"} or len(argv) != 2:
        print("uso: python -m app.files check|create-container|cleanup", file=sys.stderr)
        return 2
    from app.core.config import Settings
    from app.files.storage import FileStorageMisconfigured, FileStorageUnavailable, build_blob_store

    try:
        settings = Settings()
    except ValueError:
        print("Configuração inválida.", file=sys.stderr)
        return 2
    store = build_blob_store(settings)
    if store is None:
        print("FILE_STORAGE não é azure_blob.", file=sys.stderr)
        return 2
    try:
        if cmd == "create-container":
            created = store.create_container()
            print("container criado (privado)" if created else "container já existia (não alterado)")
            store.check()
        elif cmd == "check":
            store.check()
            print(f"container {settings.azure_storage_container}: existe e é privado")
        else:
            from app.core.clock import SystemClock
            from app.db.config import database_config_from
            from app.db.engine import engine_scope
            from app.files.cleanup import run_file_cleanup

            with engine_scope(database_config_from(settings), application_name="prazoai-files") as engine:
                print(f"removidos: {run_file_cleanup(engine, store, SystemClock().now())}")
    except FileStorageMisconfigured as exc:
        print(str(exc), file=sys.stderr)
        return 4
    except FileStorageUnavailable as exc:
        print(str(exc), file=sys.stderr)
        return 5
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
