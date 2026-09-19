// Preferências de EXIBIÇÃO e ALERTAS por usuário (persistência demonstrativa).
// Efeitos reais na UI: density (espaçamento), reduceMotion (desliga animações),
// showCompleted (filtro padrão da lista). Alertas por e-mail/digest são
// DEMONSTRATIVOS (dependem de backend) — apenas armazenados e rotulados.
export const SETTINGS_VERSION = 1;

export function defaultSettings() {
  return {
    density: "comfortable",     // "comfortable" | "compact"  (efeito real)
    reduceMotion: false,        // desliga animações           (efeito real, acessibilidade)
    showCompleted: false,       // lista de prazos já mostra concluídos por padrão (efeito real)
    // Alertas (DEMONSTRATIVOS — dependem de backend):
    emailAlerts: false,
    digest: "none",             // "daily" | "weekly" | "none"
    soonAlertDays: 3,           // 1..7
  };
}

const DENSITY = new Set(["comfortable", "compact"]);
const DIGEST = new Set(["daily", "weekly", "none"]);

/** Sanitiza um objeto de settings restaurado, caindo no padrão em campos inválidos. */
export function sanitizeSettings(raw) {
  const d = defaultSettings();
  if (!raw || typeof raw !== "object") return d;
  return {
    density: DENSITY.has(raw.density) ? raw.density : d.density,
    reduceMotion: typeof raw.reduceMotion === "boolean" ? raw.reduceMotion : d.reduceMotion,
    showCompleted: typeof raw.showCompleted === "boolean" ? raw.showCompleted : d.showCompleted,
    emailAlerts: typeof raw.emailAlerts === "boolean" ? raw.emailAlerts : d.emailAlerts,
    digest: DIGEST.has(raw.digest) ? raw.digest : d.digest,
    soonAlertDays: Number.isInteger(raw.soonAlertDays) && raw.soonAlertDays >= 1 && raw.soonAlertDays <= 7 ? raw.soonAlertDays : d.soonAlertDays,
  };
}

/** Mescla um patch validando cada campo. */
export function mergeSettings(current, patch) {
  return sanitizeSettings({ ...current, ...patch });
}
