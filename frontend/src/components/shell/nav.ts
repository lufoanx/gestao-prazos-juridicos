import type { LucideIcon } from "lucide-react";
import {
  LayoutDashboard, CalendarClock, CalendarDays, FileScan,
  Bell, Building2, Users, Settings, Sparkles, UserCircle,
} from "lucide-react";
import type { Permission } from "@/types/domain";

export interface NavItem { href: string; label: string; icon: LucideIcon; requires?: Permission; }
export interface NavSection { title?: string; items: NavItem[]; scope?: "office"; }

/**
 * Itens de navegação da aplicação (área /app).
 * A seção "Escritório" só aparece com vínculo; cada item exige a permissão
 * correspondente (gestão condicionada a vínculo + permissões).
 * Nesta etapa só o Dashboard está implementado; os demais links levam a
 * páginas-placeholder servidas pelo catch-all (nada de botão morto).
 */
export const navSections: NavSection[] = [
  {
    items: [
      { href: "/app/dashboard", label: "Dashboard", icon: LayoutDashboard },
      { href: "/app/prazos", label: "Prazos", icon: CalendarClock },
      { href: "/app/calendario", label: "Calendário", icon: CalendarDays },
      { href: "/app/intimacoes", label: "Intimações", icon: FileScan },
      { href: "/app/notificacoes", label: "Notificações", icon: Bell },
    ],
  },
  {
    title: "Escritório",
    scope: "office",
    items: [
      { href: "/app/escritorio", label: "Dados do escritório", icon: Building2, requires: "office.manage" },
      { href: "/app/escritorio/equipe", label: "Equipe", icon: Users, requires: "team.manage" },
    ],
  },
  {
    title: "Conta",
    items: [
      { href: "/app/assistente", label: "Assistente", icon: Sparkles },
      { href: "/app/perfil", label: "Perfil", icon: UserCircle },
      { href: "/app/configuracoes", label: "Configurações", icon: Settings },
    ],
  },
];
