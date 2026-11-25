"""PDFs SINTÉTICOS para testes (nenhum documento real). Estrutura mínima válida: catálogo, páginas,
uma página com fluxo de conteúdo, tabela xref, trailer, startxref e %%EOF."""
from __future__ import annotations


def synthetic_pdf(payload: bytes = b"", *, encrypted: bool = False, label: bytes = b"Documento sintetico") -> bytes:
    stream = b"BT /F1 12 Tf 20 100 Td (" + label + b") Tj ET\n" + payload
    objs = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R >>",
        b"<< /Length %d >>\nstream\n" % len(stream) + stream + b"\nendstream",
    ]
    if encrypted:
        objs.append(b"<< /Filter /Standard /V 1 /R 2 /O <00> /U <00> /P -4 >>")
    out = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
    offsets = []
    for n, body in enumerate(objs, 1):
        offsets.append(len(out))
        out += b"%d 0 obj\n" % n + body + b"\nendobj\n"
    xref = len(out)
    out += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objs) + 1)
    for off in offsets:
        out += b"%010d 00000 n \n" % off
    extra = b" /Encrypt 5 0 R /ID [<01> <01>]" if encrypted else b""
    out += b"trailer\n<< /Size %d /Root 1 0 R%s >>\nstartxref\n%d\n%%%%EOF\n" % (len(objs) + 1, extra, xref)
    return bytes(out)


def pdf_of_size(target: int) -> bytes:
    """PDF válido com tamanho exato `target` (preenchimento no fluxo de conteúdo; ajuste iterativo
    porque `/Length` e os deslocamentos da xref mudam de largura)."""
    pad = max(0, target - len(synthetic_pdf()))
    for _ in range(10):
        doc = synthetic_pdf(b"%" + b"x" * (pad - 1) if pad > 0 else b"")
        if len(doc) == target:
            return doc
        pad += target - len(doc)
    raise AssertionError(f"não foi possível gerar {target} bytes")
