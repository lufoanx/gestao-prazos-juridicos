"""Validação ESTRUTURAL básica de PDF (sem bibliotecas de renderização; nada é executado).

Aceita: 1 B a 10 MiB; cabeçalho `%PDF-x.y` no início; marcador `%%EOF` no fim; `startxref`; pelo
menos um objeto indireto e uma tabela/fluxo de referências. Recusa: arquivos que não são PDF
(independentemente de extensão/Content-Type), estrutura truncada ou malformada e PDFs protegidos
por senha (`/Encrypt`). Não detecta malware nem garante que o documento abre em qualquer leitor.
"""
from __future__ import annotations

import re

MAX_PDF_BYTES = 10 * 1024 * 1024          # igual ao CHECK `file_size_range` do banco
_HEADER = re.compile(rb"^%PDF-[12]\.[0-9]")
_OBJ = re.compile(rb"(?<!\d)\d{1,10}\s{1,8}\d{1,5}\s{1,8}obj\b")
_ENCRYPT = re.compile(rb"/Encrypt\b")
# Palavra-chave `xref` em início de linha (não a contida em `startxref`) ou fluxo de referências.
_XREF = re.compile(rb"(?:^|[\r\n])xref[\r\n ]|/Type\s*/XRef\b")


class PdfRejected(ValueError):
    def __init__(self, code: str, message: str, status: int = 422) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = status


def validate_pdf(data: bytes) -> None:
    if not data:
        raise PdfRejected("file_empty", "O arquivo está vazio.")
    if len(data) > MAX_PDF_BYTES:
        raise PdfRejected("file_too_large", "O arquivo excede 10 MiB.", status=413)
    if not _HEADER.match(data):
        raise PdfRejected("file_not_pdf", "O conteúdo não é um PDF.", status=415)
    tail = data[-2048:]
    if b"%%EOF" not in tail[-1024:] or b"startxref" not in tail:
        raise PdfRejected("pdf_invalid", "PDF incompleto ou malformado.")
    if not _OBJ.search(data) or not _XREF.search(data):
        raise PdfRejected("pdf_invalid", "PDF incompleto ou malformado.")
    if _ENCRYPT.search(data):
        raise PdfRejected("pdf_encrypted", "PDFs protegidos por senha não são aceitos nesta versão.")
