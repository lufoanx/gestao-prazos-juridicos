import type { ReactNode } from "react";
import { IntegratedOnboarding } from "@/integrated/IntegratedOnboarding";
import { APP_MODE } from "@/lib/integration/mode.mjs";

// Modo integrado (6.2): onboarding real (ambiente pessoal ou criação de escritório).
// As telas demonstrativas de /onboarding/* nunca são renderizadas no modo integrado.
export default function OnboardingLayout({ children }: { children: ReactNode }) {
  return APP_MODE === "integrated" ? <IntegratedOnboarding /> : children;
}
