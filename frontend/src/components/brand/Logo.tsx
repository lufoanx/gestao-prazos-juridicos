import Image from "next/image";

/**
 * Logo aprovada do PrazoAI (marca "P" + marcador temporal).
 * - Fundo claro  → versão azul (navy/teal): prazoai-conceito.png
 * - Fundo escuro → versão branca (legível sobre navy): prazoai-branca.png
 * A versão vetorial (SVG) ainda é pendência — ver docs/frontend/pendencias.md.
 * Não recriar/alterar a marca aqui.
 */
export function Logo({ height = 30, onDark = false }: { height?: number; onDark?: boolean }) {
  // Proporção original 1875x839 ≈ 2.234
  const width = Math.round(height * (1875 / 839));
  const src = onDark ? "/brand/prazoai-branca.png" : "/brand/prazoai-conceito.png";
  return (
    <Image
      src={src}
      alt="PrazoAI"
      width={width}
      height={height}
      priority
      style={{ height, width: "auto", objectFit: "contain" }}
    />
  );
}
