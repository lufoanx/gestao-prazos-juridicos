"use client";
// Modo integrado: dashboard real via BFF (totais do servidor); o modo demo segue inalterado.
import { DashboardView } from "@/components/dashboard/DashboardView";
import { IntegratedDashboard } from "@/integrated/IntegratedDashboard";
import { APP_MODE } from "@/lib/integration/mode.mjs";

export default function DashboardPage() {
  return APP_MODE === "integrated" ? <IntegratedDashboard /> : <DashboardView />;
}
