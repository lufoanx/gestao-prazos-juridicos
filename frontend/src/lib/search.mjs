// Helper puro para a busca global do cabeçalho → lista de prazos.
// Trata espaços e caracteres especiais via encodeURIComponent.
export function buildSearchHref(term) {
  const t = String(term ?? "").trim();
  return t ? `/app/prazos?q=${encodeURIComponent(t)}` : "/app/prazos";
}
