// PDFs SINTÉTICOS para testes (nenhum documento real). Mesma estrutura do gerador do backend
// (backend/tests/pdf_samples.py): catálogo, páginas, uma página, fluxo de conteúdo, xref, trailer.
export function syntheticPdf({ payload = "", encrypted = false, label = "Documento sintetico" } = {}) {
  const stream = `BT /F1 12 Tf 20 100 Td (${label}) Tj ET\n${payload}`;
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ];
  if (encrypted) objs.push("<< /Filter /Standard /V 1 /R 2 /O <00> /U <00> /P -4 >>");
  let out = "%PDF-1.4\n%âãÏÓ\n";
  const parts = [Buffer.from(out, "latin1")];
  let len = parts[0].length;
  const offsets = [];
  objs.forEach((body, n) => {
    offsets.push(len);
    const b = Buffer.from(`${n + 1} 0 obj\n${body}\nendobj\n`, "latin1");
    parts.push(b); len += b.length;
  });
  const xref = len;
  out = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R${encrypted ? " /Encrypt 5 0 R" : ""} >>\nstartxref\n${xref}\n%%EOF\n`;
  parts.push(Buffer.from(out, "latin1"));
  return Buffer.concat(parts);
}

/** PDF válido com tamanho exato (preenchimento no fluxo; ajuste iterativo). */
export function pdfOfSize(target) {
  let pad = Math.max(0, target - syntheticPdf().length);
  for (let i = 0; i < 10; i++) {
    const doc = syntheticPdf({ payload: pad > 0 ? "%" + "x".repeat(pad - 1) : "" });
    if (doc.length === target) return doc;
    pad += target - doc.length;
  }
  throw new Error(`não foi possível gerar ${target} bytes`);
}
