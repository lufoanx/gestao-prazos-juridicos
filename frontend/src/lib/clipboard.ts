// Copia para a área de transferência sem deixar promessa solta: falha (sem permissão/sem API) é ignorada.
export async function copyText(text: string): Promise<boolean> {
  try {
    if (!navigator.clipboard) return false;
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
