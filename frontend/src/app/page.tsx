import Link from "next/link";
import {
  ShieldCheck, CalendarClock, Users, FileScan, Bell, Accessibility,
  UserRound, Building2, ArrowRight, Info,
} from "lucide-react";
import { PublicNav } from "@/components/public/PublicNav";
import { Faq } from "@/components/public/Faq";
import { Logo } from "@/components/brand/Logo";

const FEATURES = [
  { icon: CalendarClock, title: "Prazos em primeiro lugar", desc: "Cadastro focado em prazos jurídicos: processo, tribunal, área, responsável, vencimento e prioridade — sem módulos que você não pediu." },
  { icon: ShieldCheck, title: "Urgência visível", desc: "Vencido, para hoje e próximos dias aparecem como agrupamento visual claro, sempre com rótulo e ícone — nunca só cor." },
  { icon: Users, title: "Pessoal e escritório", desc: "Alterne entre o seu ambiente pessoal e o do escritório. Cada um tem suas listas, contadores e notificações." },
  { icon: FileScan, title: "Revisão de intimações", desc: "Intimações passam por revisão obrigatória antes de virar prazo. Você confirma os dados — nada é aceito automaticamente." },
  { icon: Bell, title: "Agenda e notificações", desc: "A agenda do dia e as notificações acompanham o ambiente ativo, mantendo o foco no que vence agora." },
  { icon: Accessibility, title: "Acessível desde o começo", desc: "Foco visível, navegação por teclado, rótulos associados e contraste cuidado fazem parte do produto, não de um extra." },
];

const STEPS = [
  { t: "Crie sua conta", d: "Cadastro rápido com e-mail e senha. Sem pedir OAB logo de início." },
  { t: "Escolha seu ambiente", d: "Trabalhe como autônomo, crie um escritório ou ingresse em um existente." },
  { t: "Acompanhe seus prazos", d: "Veja urgentes, agenda do dia e intimações para revisão em um só lugar." },
];

const FAQ = [
  { q: "O PrazoAI já está pronto para produção?", a: "Esta é uma versão demonstrativa navegável. As telas e os fluxos funcionam, mas os dados são fictícios e não há backend, autenticação ou integrações reais nesta fase." },
  { q: "A leitura de intimações por IA é real?", a: "Não. O processamento de PDF e a sugestão de dados são simulados e sempre rotulados como demonstrativos. Você revisa e confirma tudo manualmente antes de criar um prazo." },
  { q: "O login com Google funciona?", a: "O botão do Google é demonstrativo: ele não consulta nenhuma conta Google nem realiza OAuth real. Existe apenas para representar o fluxo futuro." },
  { q: "A urgência é um cálculo de prazo processual oficial?", a: "Não. A urgência (vencido, hoje, próximo) é um agrupamento visual baseado na data de vencimento e em um relógio demonstrativo. Não substitui o cálculo processual oficial." },
  { q: "Meus prazos pessoais ficam visíveis para o escritório?", a: "Não. Prazos pessoais pertencem apenas a você. Ingressar em um escritório não compartilha nem transfere seus prazos pessoais." },
];

export default function Landing() {
  return (
    <>
      <PublicNav />
      <main id="conteudo">
        {/* Hero */}
        <section className="lp-hero">
          <div className="lp-hero__inner">
            <div className="lp-hero__text">
              <span className="lp-eyebrow"><CalendarClock size={16} aria-hidden /> Gestão de prazos jurídicos</span>
              <h1>Seus prazos jurídicos organizados com clareza.</h1>
              <p className="lead">
                O PrazoAI reúne prazos, agenda do dia e intimações para revisão em um
                painel simples — para advogados autônomos e equipes de escritório.
              </p>
              <div className="lp-cta">
                <Link className="btn btn--primary btn--lg" href="/cadastro">Criar conta grátis <ArrowRight size={17} aria-hidden /></Link>
                <Link className="btn btn--secondary btn--lg" href="/app/dashboard">Ver o dashboard</Link>
              </div>
              <p className="lp-hero__note">Versão demonstrativa navegável · dados fictícios · sem integrações reais.</p>
            </div>

            {/* Demonstração visual (mock, não alega dados reais) */}
            <div className="lp-demo" role="img" aria-label="Demonstração visual do painel de prazos do PrazoAI">
              <div className="lp-demo__bar">
                <span className="lp-demo__dot" /><span className="lp-demo__dot" /><span className="lp-demo__dot" />
                <span className="lp-demo__tag">PrazoAI · demonstração</span>
              </div>
              <div className="lp-demo__body">
                <div className="lp-demo__stats">
                  <div className="lp-demo__stat"><b>1</b><span>Vencidos</span></div>
                  <div className="lp-demo__stat"><b>2</b><span>Vencem hoje</span></div>
                  <div className="lp-demo__stat"><b>1</b><span>Próximos</span></div>
                </div>
                <div className="lp-demo__row">
                  <div><b>Contestação</b><small>0012345-67 · TJSC</small></div>
                  <span className="lp-demo__pill">Vence hoje</span>
                </div>
                <div className="lp-demo__row lp-demo__row--teal">
                  <div><b>Réplica</b><small>0088888-12 · TRT-12</small></div>
                  <span className="lp-demo__pill lp-demo__pill--teal">Em 2 dias</span>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Recursos */}
        <section className="lp-section" id="recursos">
          <div className="lp-section__head">
            <h2 className="lp-h2">Feito exclusivamente para prazos</h2>
            <p className="lp-sub">Sem financeiro, CRM ou gestão geral de processos. O foco é ajudar você a não perder um prazo.</p>
          </div>
          <div className="lp-features">
            {FEATURES.map((f) => {
              const Icon = f.icon;
              return (
                <div className="lp-feature" key={f.title}>
                  <div className="lp-feature__icon"><Icon size={20} aria-hidden /></div>
                  <h3>{f.title}</h3>
                  <p>{f.desc}</p>
                </div>
              );
            })}
          </div>
        </section>

        {/* Como funciona */}
        <section className="lp-section" id="como-funciona">
          <div className="lp-section__head">
            <h2 className="lp-h2">Como funciona</h2>
            <p className="lp-sub">Três passos para começar a acompanhar seus prazos.</p>
          </div>
          <div className="lp-steps">
            {STEPS.map((s, i) => (
              <div className="lp-step" key={i}>
                <div className="lp-step__n">{i + 1}</div>
                <h3>{s.t}</h3>
                <p>{s.d}</p>
              </div>
            ))}
          </div>
        </section>

        {/* Para quem é */}
        <section className="lp-section" id="para-quem">
          <div className="lp-section__head">
            <h2 className="lp-h2">Para autônomos e escritórios</h2>
            <p className="lp-sub">O mesmo produto se adapta ao seu contexto, com ambientes separados.</p>
          </div>
          <div className="lp-split">
            <div className="lp-usecase">
              <h3><UserRound size={20} aria-hidden /> Advogado autônomo</h3>
              <ul>
                <li>Ambiente pessoal privado, só seu.</li>
                <li>Cadastro de prazos com prioridade e observações.</li>
                <li>Agenda do dia e alerta de urgências.</li>
                <li>Nada é compartilhado sem você decidir.</li>
              </ul>
            </div>
            <div className="lp-usecase">
              <h3><Building2 size={20} aria-hidden /> Escritório</h3>
              <ul>
                <li>Equipe com cargos, áreas e permissões separados.</li>
                <li>Visibilidade por responsável ou por todo o escritório.</li>
                <li>Ingresso por convite ou solicitação.</li>
                <li>Transferência explícita de prazos, com histórico.</li>
              </ul>
            </div>
          </div>
        </section>

        {/* FAQ */}
        <section className="lp-section" id="faq">
          <div className="lp-section__head">
            <h2 className="lp-h2">Perguntas frequentes</h2>
            <p className="lp-sub">O que esta versão demonstrativa faz — e o que ainda não faz.</p>
          </div>
          <Faq items={FAQ} />
        </section>

        {/* CTA final */}
        <section className="lp-cta-band">
          <h2>Comece a organizar seus prazos agora</h2>
          <p>Crie uma conta demonstrativa em segundos e explore o painel completo.</p>
          <div style={{ display: "flex", gap: 12, justifyContent: "center", flexWrap: "wrap" }}>
            <Link className="btn btn--teal btn--lg" href="/cadastro">Criar conta</Link>
            <Link className="btn btn--ghost btn--lg" href="/login" style={{ color: "#fff", borderColor: "rgba(255,255,255,.4)" }}>Entrar</Link>
          </div>
        </section>
      </main>

      {/* Rodapé */}
      <footer className="lp-footer">
        <div className="lp-footer__inner">
          <div>
            <Logo height={30} onDark />
            <p className="lp-footer__note">
              <Info size={14} aria-hidden style={{ verticalAlign: "-2px", marginRight: 6 }} />
              Versão demonstrativa. Dados fictícios; sem autenticação, IA ou integrações reais.
            </p>
          </div>
          <div>
            <strong style={{ color: "#fff", fontSize: "var(--fs-sm)" }}>Acesso</strong>
            <Link href="/login">Entrar</Link>
            <Link href="/cadastro">Criar conta</Link>
            <Link href="/onboarding">Configurar ambiente</Link>
          </div>
          <div>
            <strong style={{ color: "#fff", fontSize: "var(--fs-sm)" }}>Produto</strong>
            <Link href="/app/dashboard">Dashboard</Link>
          </div>
        </div>
      </footer>
    </>
  );
}
