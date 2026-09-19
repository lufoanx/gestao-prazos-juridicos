import Link from "next/link";
import { UserRound, Building2, KeyRound, ArrowRight } from "lucide-react";
import { OnboardingShell } from "@/components/public/OnboardingShell";

const CHOICES = [
  {
    href: "/onboarding/autonomo", icon: UserRound,
    title: "Sou autônomo",
    desc: "Trabalho por conta própria. Quero um ambiente pessoal só meu para acompanhar prazos.",
    cta: "Configurar ambiente pessoal",
  },
  {
    href: "/onboarding/escritorio", icon: Building2,
    title: "Criar um escritório",
    desc: "Vou administrar uma equipe. Crio o escritório e depois convido os membros.",
    cta: "Criar escritório",
  },
  {
    href: "/solicitar-ingresso", icon: KeyRound,
    title: "Ingressar em um escritório",
    desc: "Já existe um escritório e quero fazer parte dele por convite ou solicitação.",
    cta: "Solicitar ingresso",
  },
];

export default function OnboardingPage() {
  return (
    <OnboardingShell
      title="Como você vai usar o PrazoAI?"
      subtitle="Você pode mudar depois. Seu ambiente pessoal continua sempre disponível."
      wide
    >
      <div className="onb__choices">
        {CHOICES.map((c) => {
          const Icon = c.icon;
          return (
            <Link key={c.href} href={c.href} className="choice">
              <span className="choice__icon"><Icon size={24} aria-hidden /></span>
              <span className="choice__title">{c.title}</span>
              <span className="choice__desc">{c.desc}</span>
              <span className="choice__cta">{c.cta} <ArrowRight size={15} aria-hidden /></span>
            </Link>
          );
        })}
      </div>
    </OnboardingShell>
  );
}
