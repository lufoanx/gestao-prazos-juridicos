import { redirect } from "next/navigation";

// /app sozinho redireciona para o Dashboard (evita ambiguidade com o catch-all).
export default function AppIndex() {
  redirect("/app/dashboard");
}
