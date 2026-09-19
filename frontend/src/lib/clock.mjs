// Relógio demonstrativo controlável.
// Os exemplos usam uma data fixa para não ficarem obsoletos com o tempo real.
// Em produção isto seria substituído pela data real do servidor.

export const DEMO_TODAY = "2026-09-16";

let current = DEMO_TODAY;

/** Data civil "de hoje" no modo demonstrativo (YYYY-MM-DD). */
export function getDemoToday() {
  return current;
}

/** Permite alternar cenários de demonstração. */
export function setDemoToday(iso) {
  current = iso;
}

/** Restaura o padrão. */
export function resetDemoToday() {
  current = DEMO_TODAY;
}
