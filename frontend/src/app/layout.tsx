import type { Metadata } from "next";
import "./globals.css";
import { SessionProvider } from "@/context/SessionContext";
import { OrgProvider } from "@/context/OrgContext";
import { AuthProvider } from "@/integrated/AuthProvider";
import { OrgProvider as IntegratedOrgProvider } from "@/integrated/OrgProvider";
import { APP_MODE } from "@/lib/integration/mode.mjs";

export const metadata: Metadata = {
  title: "PrazoAI — Gestão de prazos jurídicos",
  description: "Organize prazos jurídicos com clareza. Ambiente demonstrativo.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="pt-BR">
      <body>
        <a href="#conteudo" className="skip-link">Pular para o conteúdo</a>
        {APP_MODE === "integrated"
          ? <AuthProvider><IntegratedOrgProvider>{children}</IntegratedOrgProvider></AuthProvider>  /* não lê chaves demonstrativas */
          : <SessionProvider><OrgProvider>{children}</OrgProvider></SessionProvider>}
      </body>
    </html>
  );
}
