"""Armazenamento PRIVADO de PDFs no Azure Blob Storage (Azurite nos testes).

- Chaves geradas no servidor (`intimations/<uuid4>.pdf`); o nome enviado nunca vira caminho.
- Upload com `overwrite=False` (uma chave, um conteúdo) e Content-Type fixo.
- O container precisa existir e NÃO ter acesso público (conferido por `check()`); a aplicação nunca
  o cria nem altera sua política (comando explícito `python -m app.files create-container`).
- Erros do SDK viram `FileStorageUnavailable` sem detalhes (nada de conta, chave ou URL nos logs).
"""
from __future__ import annotations

import uuid
from collections.abc import Iterator
from dataclasses import dataclass
from typing import Any, Protocol

KEY_PREFIX = "intimations/"


class FileStorageUnavailable(RuntimeError):
    """Armazenamento de arquivos indisponível ou com resposta incerta."""


class FileStorageMisconfigured(RuntimeError):
    """Container ausente ou PÚBLICO: a aplicação recusa usá-lo."""


class StoredFileMissing(RuntimeError):
    """Metadado indica arquivo armazenado, mas o blob não existe (inconsistência)."""


def new_blob_key() -> str:
    return f"{KEY_PREFIX}{uuid.uuid4().hex}.pdf"


@dataclass(frozen=True)
class BlobDownload:
    size: int
    chunks: Iterator[bytes]


class BlobStore(Protocol):
    def put(self, key: str, data: bytes) -> None: ...
    def open(self, key: str) -> BlobDownload: ...
    def delete(self, key: str) -> None: ...
    def check(self) -> None: ...


class AzureBlobStore:
    def __init__(self, connection_string: str, container: str, timeout_seconds: int) -> None:
        from azure.storage.blob import BlobServiceClient  # tardio: só com FILE_STORAGE=azure_blob

        self._timeout = timeout_seconds
        self._service = BlobServiceClient.from_connection_string(
            connection_string, connection_timeout=timeout_seconds, read_timeout=timeout_seconds,
            retry_total=2,
        )
        self._container = self._service.get_container_client(container)

    def __repr__(self) -> str:  # nunca imprime a conexão
        return f"AzureBlobStore(container={self._container.container_name!r})"

    def _blob(self, key: str) -> Any:
        if not key.startswith(KEY_PREFIX) or "/" in key[len(KEY_PREFIX):] or ".." in key:
            raise ValueError("chave de arquivo inválida")
        return self._container.get_blob_client(key)

    def put(self, key: str, data: bytes) -> None:
        from azure.core.exceptions import AzureError
        from azure.storage.blob import ContentSettings

        try:
            self._blob(key).upload_blob(
                data, overwrite=False, timeout=self._timeout,
                content_settings=ContentSettings(content_type="application/pdf"),
            )
        except AzureError:
            raise FileStorageUnavailable("falha ao gravar arquivo") from None

    def open(self, key: str) -> BlobDownload:
        from azure.core.exceptions import AzureError, ResourceNotFoundError

        try:
            downloader = self._blob(key).download_blob(timeout=self._timeout)
        except ResourceNotFoundError:
            raise StoredFileMissing("arquivo ausente no armazenamento") from None
        except AzureError:
            raise FileStorageUnavailable("falha ao ler arquivo") from None

        def chunks() -> Iterator[bytes]:
            try:
                yield from downloader.chunks()
            except AzureError:
                raise FileStorageUnavailable("falha ao ler arquivo") from None

        return BlobDownload(size=int(downloader.size), chunks=chunks())

    def delete(self, key: str) -> None:
        """Idempotente: blob inexistente conta como removido."""
        from azure.core.exceptions import AzureError, ResourceNotFoundError

        try:
            self._blob(key).delete_blob(timeout=self._timeout)
        except ResourceNotFoundError:
            return
        except AzureError:
            raise FileStorageUnavailable("falha ao remover arquivo") from None

    def check(self) -> None:
        from azure.core.exceptions import AzureError, ResourceNotFoundError

        try:
            props = self._container.get_container_properties(timeout=self._timeout)
        except ResourceNotFoundError:
            raise FileStorageMisconfigured("container de arquivos ausente") from None
        except AzureError:
            raise FileStorageUnavailable("armazenamento de arquivos indisponível") from None
        if props.public_access is not None:
            raise FileStorageMisconfigured("container de arquivos com acesso público")

    def create_container(self) -> bool:
        """Só pelo comando explícito. Cria PRIVADO; devolve False se já existia (sem alterar nada)."""
        from azure.core.exceptions import ResourceExistsError

        try:
            self._container.create_container(public_access=None, timeout=self._timeout)
            return True
        except ResourceExistsError:
            return False


def build_blob_store(settings) -> AzureBlobStore | None:
    if settings.file_storage != "azure_blob":
        return None
    return AzureBlobStore(settings.azure_storage_connection_string.get_secret_value(),
                          settings.azure_storage_container, settings.file_storage_timeout_seconds)
