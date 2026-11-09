import { redirect } from "next/navigation";
import { IntegratedHome } from "@/integrated/IntegratedHome";
import { APP_MODE } from "@/lib/integration/mode.mjs";

// /app: no modo demo redireciona para o Dashboard; no integrado mostra o início da 6.1.
export default function AppIndex() {
  if (APP_MODE === "integrated") return <IntegratedHome />;
  redirect("/app/dashboard");
}
