export interface DemoSettings {
  density: "comfortable" | "compact";
  reduceMotion: boolean;
  showCompleted: boolean;
  emailAlerts: boolean;
  digest: "daily" | "weekly" | "none";
  soonAlertDays: number;
}
export const SETTINGS_VERSION: number;
export function defaultSettings(): DemoSettings;
export function sanitizeSettings(raw: unknown): DemoSettings;
export function mergeSettings(current: DemoSettings, patch: Partial<DemoSettings>): DemoSettings;
