"use client";
import type { ReactNode } from "react";
import { ScopeProvider } from "@/context/ScopeContext";
import { DataProvider } from "@/context/DataContext";
import { SettingsProvider } from "@/context/SettingsContext";
import { ToastProvider } from "@/components/ui";
import { Sidebar } from "./Sidebar";
import { Header } from "./Header";
import { IntimationProcessor } from "./IntimationProcessor";
import { ShellChrome } from "./ShellChrome";

/**
 * Casca da aplicação: providers (escopo + dados + preferências + toasts), sidebar
 * fixa, header e área de conteúdo. Preferências de exibição (densidade, animações)
 * têm efeito real via classes aplicadas em ShellChrome.
 */
export function AppShell({ children }: { children: ReactNode }) {
  return (
    <ToastProvider>
      <ScopeProvider>
        <SettingsProvider>
          <DataProvider>
            <IntimationProcessor />
            <ShellChrome>
              <Sidebar />
              <div className="app-main">
                <Header />
                <main className="app-content" id="conteudo">{children}</main>
              </div>
            </ShellChrome>
          </DataProvider>
        </SettingsProvider>
      </ScopeProvider>
    </ToastProvider>
  );
}
