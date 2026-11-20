# 26 — Ambientes pessoal e escritório: diagnóstico do relato e descoberta das ações existentes

> **Tipo de entrega:** correções de navegação e descoberta no frontend (modos demo e integrado), com
> testes e documentação. Nada muda no backend, no BFF, nos contratos, nas dependências, nas migrations
> nem nas regras de negócio. Não há funcionalidade nova, endpoint novo nem segundo login.
>
> **Base:** `main` `c74d93a0512a86fccddba35aedb735f46ac07482` (merge do PR #31), árvore
> `864e31ccbc8ced1e2b515b5c2bcec196995fd0fa`, CI pós-merge `44634677234` verde nos quatro jobs
> (conferido pela API do GitHub). Branch `fix/fluxo-pessoal-escritorio`. A árvore local estava limpa e
> idêntica à main, sem divergências.

## 1. O relato e o que foi possível concluir
> "Clico em escritório e parece que não funciona. Não achei como entrar como escritório, só como pessoal."

O modo (demo ou integrado) e o estado da conta de quem relatou **não são conhecidos**. Por isso, esta
entrega **não afirma ter reproduzido a situação da pessoa**. Ela reproduziu, no navegador, os estados
em que o relato descreve exatamente o que acontece (§3) e corrigiu esses estados.

| Situação | É defeito? | O que a pessoa via na base |
|---|---|---|
| **Modo demo**, login ou cadastro sem criar escritório | **sim, de descoberta** | botão "Escritório" desabilitado no seletor, sem estilo de desabilitado; o motivo só aparecia num `title`, que não aparece ao toque. Nenhum caminho dentro de `/app` levava a criar ou ingressar |
| **Modo demo**, visita direta sem sessão (persona semeada com escritório) | não | o seletor alterna normalmente |
| **Integrado**, conta **sem vínculo** | **sim, de descoberta** | seletor "Ambiente" só com "Pessoal"; **sem** "Escritório" na navegação; `/app/escritorio` e `/equipe` por URL: "Você não pertence a um escritório no momento.", sem nenhuma ação |
| **Integrado**, **com vínculo** e **ambiente pessoal selecionado** | **sim, de descoberta** | clicar em "Escritório" abria uma tela só com o texto "Selecione o ambiente do escritório no topo…" |
| **Integrado**, membro sem "Gerir equipe" | não | a tela do escritório mostra só o permitido e explica o motivo ("geridos por quem tem a permissão…") |
| **Integrado**, leitura do vínculo com erro não 5xx (ex.: 429) | **sim, erro silencioso** | nenhum aviso; as telas do escritório ficavam em "Carregando…" para sempre |
| **Integrado**, serviço indisponível (5xx ou rede) | não (já tratado) | aviso com "Tentar novamente" na casca |

## 2. Conta, vínculo e ambiente (confirmado no código)
- **Conta:** **uma só**. Existe um único login (`POST /api/v1/auth/login`, `backend/app/api/auth.py`)
  e não há "login de escritório". No modo integrado, o BFF guarda a sessão no servidor e a interface
  só conhece o usuário (`frontend/src/integrated/AuthProvider.tsx`).
- **Vínculo:** a participação da conta num escritório, lida do servidor em `GET /memberships/me`
  (`frontend/src/lib/integration/org-controller.mjs`).
  - **No máximo um escritório por pessoa.** Criar, aceitar convite, solicitar e aprovar recusam um
    segundo vínculo com 409 `already_in_office` (`backend/app/services/org_service.py`, linhas 186,
    434, 458 e 533).
  - As permissões vêm do vínculo e são validadas pelo backend. O cargo é só um rótulo.
- **Ambiente:** o contexto de navegação ("Pessoal" ou "Escritório: <nome>"), escolhido pela pessoa no
  seletor do topo.
  - O **pessoal sempre existe** e é privado.
  - O **do escritório** só pode ser escolhido com vínculo atual (`selectScope` recusa sem vínculo).
  - **Trocar de ambiente não transfere nada.** A transferência de um prazo é uma ação explícita,
    separada.
  - A troca aumenta a época do cliente (respostas antigas descartadas) e remonta o conteúdo
    (`IntegratedShell`, chave com usuário, escritório, ambiente e revisão).
- **Modo demo:** reproduz os mesmos conceitos com dados fictícios no navegador (`localStorage`); não
  há servidor, e-mail nem banco.

## 3. Caminhos exatos (base `c74d93a`), reproduzidos no navegador
Execuções locais:
- **Modo demo:** build com o modo vazio (`npm run build`, `next start`) e uma sonda temporária em
  Playwright.
- **Modo integrado:** harness do E2E (build integrado, BFF, FastAPI e PostgreSQL reais) com uma spec
  temporária.

As duas sondas não foram versionadas e imprimiram só textos da interface.

| Ação | Modo integrado | Modo demo |
|---|---|---|
| Cadastro e primeiro acesso | `/cadastro` → `/onboarding` | `/cadastro` → `/onboarding` |
| Escolher pessoal | `/onboarding` → "Usar ambiente pessoal" → `/app` | `/onboarding` → "Sou autônomo" → `/onboarding/autonomo` |
| Criar escritório | `/onboarding` → formulário "Criar escritório" → `/app/escritorio` (ambiente do escritório) | `/onboarding/escritorio` → `/app/dashboard` (ambiente do escritório) |
| Ingresso por convite | quem administra: `/app/escritorio` → "Gerar link de convite" e envio do link por conta própria; convidado: abre `/convite#…` → "Aceitar convite" | `/app/escritorio/equipe` (link demonstrativo) |
| Solicitação por código | `/solicitar-ingresso` → código; quem administra aprova em `/app/escritorio` ("Solicitações de ingresso") | `/solicitar-ingresso` (simulado) |
| Trocar de ambiente | seletor "Ambiente" no topo (recarga mantém a escolha da aba; aba nova abre no escritório) | botões "Pessoal" e "Escritório" na barra lateral ou no menu em tela estreita |
| Administrador × membro | controles conforme as permissões atuais (`capabilities`); o servidor decide | idem, com regras locais |
| Sair ou ser removido | `/app/escritorio/equipe` → "Sair do escritório" (o último administrador indica um sucessor); remoção pela equipe; a sessão do removido volta ao pessoal | `/app/escritorio` → sair |

**Reproduzido na base** (contas fictícias `@exemplo.com`):
- **demo:** depois do login, o botão "Escritório" está `disabled`; o motivo existe só no `title`
  "Você ainda não participa de um escritório". `/app/escritorio` mostra "Alterne para um escritório
  (ou crie um)", **sem link**. Em tela estreita, o seletor fica no menu, com o mesmo comportamento.
- **integrado sem vínculo:** a navegação mostra "Início, Perfil, Dashboard, Prazos, Calendário,
  Intimações, Notificações", **sem** Escritório. O seletor só tem "Pessoal". A dica com "Criar
  escritório" e "Entrar com código" existe **só** no cartão da página inicial `/app`.
- **integrado com vínculo no pessoal:** "Escritório" → "Você está no ambiente pessoal. Selecione o
  ambiente do escritório no topo para ver esta área." "Equipe" → "Selecione o ambiente do escritório no
  topo para ver a equipe."
- **integrado, vínculo com erro 429 (simulado):** nenhum aviso, e "Carregando…" sem fim (§6, último
  teste).

## 4. Correções (delimitadas)
Uma decisão de interface **compartilhada pelos dois modos**: `frontend/src/lib/office-entry.mjs`
(`officeEntryState`) define os textos e o estado.

| Estado | O que a tela mostra |
|---|---|
| carregando | "Carregando…" |
| erro | aviso, nunca "sem escritório" |
| sem vínculo | criar ou ingressar |
| ambiente pessoal com vínculo | troca explícita |
| escritório | o conteúdo |

| # | Defeito comprovado | Correção | Arquivos |
|---|---|---|---|
| 1 | Demo: "Escritório" indisponível só com `title` | texto **visível** "Sem escritório: criar ou ingressar" (link para `/onboarding`), ligado ao botão por `aria-describedby`; estilo de desabilitado (`opacity`, `not-allowed`) | `components/shell/ScopeSwitcher.tsx`, `globals.css` |
| 2 | Demo: `/app/escritorio` e `/equipe` sem saída, mesma mensagem para "sem vínculo" e "ambiente pessoal" | sem vínculo: "Criar escritório" (`/onboarding/escritorio`) e "Solicitar ingresso com código" (`/solicitar-ingresso`); no pessoal com vínculo: "Abrir ambiente do escritório" | `components/shell/DemoOfficeEntry.tsx`, as duas páginas demo |
| 3 | Integrado: sem vínculo, nenhuma entrada "Escritório" | "Escritório" **sempre** na navegação; "Equipe" continua só com vínculo | `integrated/IntegratedShell.tsx` |
| 4 | Integrado: `/app/escritorio` e `/equipe` sem vínculo, sem ação | "Criar escritório" (`/onboarding`), "Solicitar ingresso com código" (`/solicitar-ingresso`) e a dica do convite. O texto anterior foi mantido | `integrated/OfficeGate.tsx` |
| 5 | Integrado: com vínculo no pessoal, só a instrução "selecione no topo" | botão **"Abrir ambiente do escritório"** (`selectScope("office")`), o mesmo padrão de "Abrir no ambiente…" dos prazos (auditoria 6.3) | `integrated/OfficeGate.tsx` |
| 6 | Integrado: erro não 5xx na leitura do vínculo era silencioso | a casca mostra o aviso com "Tentar novamente" também para `error`; as telas do escritório mostram uma espera explicada, não "Carregando…" | `integrated/IntegratedShell.tsx`, `OfficeGate.tsx` |

**Regras preservadas:**
- O servidor continua decidindo vínculo e permissões. `OfficeGate` só escolhe o que exibir.
- Nada aparece sem vínculo atual. Durante o carregamento ou o erro, não se afirma "sem escritório".
- O conteúdo do escritório só é renderizado no ambiente do escritório.
- A troca de ambiente continua explícita e sem transferência.
- Época, revisão e remontagem não mudaram.
- Convites, notificações e recuperação de senha não foram tocados.

**Decisão pendente, não implementada:** no modo integrado, quem escolheu "Usar ambiente pessoal" no
onboarding fica com essa preferência de navegação na aba (`sessionStorage`) **mesmo depois** de
ingressar num escritório. O controlador aplica `stored === "personal"` no primeiro carregamento.
- A situação foi reproduzida no teste de ingresso (§6): depois da aprovação, a pessoa abre
  "Escritório" e encontra a troca explícita.
- Fazer o ingresso abrir automaticamente o escritório mudaria a regra do controlador, já auditada.
  Fica para decisão: manter como está, ou dar preferência ao escritório quando um vínculo novo
  aparece.

## 5. Alternativas descartadas
- **Clicar em "Escritório" trocar o ambiente sozinho:** a navegação passaria a mudar o contexto de dados
  sem uma ação explícita. Contraria a regra de troca explícita usada nos prazos e intimações.
- **Mostrar "Escritório" habilitado no seletor sem vínculo:** pareceria disponível e ignoraria a ação.
- **Login ou rota separada "de escritório":** criaria um segundo sistema de entrada (proibido) e não
  existe no backend.

## 6. Testes
**Unitário** (`frontend/tests/office-entry.test.mjs`, 3 testes):
- carregamento e erro nunca viram "sem escritório";
- preferência antiga sem vínculo não concede o ambiente do escritório;
- os textos nomeiam as ações existentes e não prometem transferência.

Na base, o módulo não existe e o teste falha (`ERR_MODULE_NOT_FOUND`).

**E2E integrado** (`frontend/e2e/office-entry.spec.ts`, BFF, FastAPI e PostgreSQL reais, sem sleep,
force, retries nem timeout maior):

| Teste | O que prova | Base `c74d93a` | Com a correção |
|---|---|---|---|
| sem escritório | "Escritório" na navegação (sem "Equipe"); a tela e a URL direta da equipe mostram criar ou solicitar; **criar pelo caminho apresentado** abre o escritório como administrador | **falha**: link "Escritório" ausente | passa |
| com escritório no pessoal | escritório → pessoal → (recarga mantém o pessoal) → **"Abrir ambiente do escritório"** → escritório; URL direta da equipe no escritório; volta ao pessoal sem controles do escritório; "Prazos" informa o ambiente pessoal | **falha**: botão ausente | passa |
| ingresso pelo caminho apresentado | "Escritório" → "Solicitar ingresso com código" → aprovação → troca explícita → membro **sem** controles de administração; **segundo vínculo recusado** em `/solicitar-ingresso` e `/onboarding` | **falha**: link "Escritório" ausente | passa |
| vínculo pendente ou com erro | resposta **real retida** (gate): "Carregando…", nunca "sem escritório"; erro **simulado** 429: aviso visível, nenhum dado anterior, "Tentar novamente" recupera | **falha**: aviso ausente | passa |

**Cobertura reaproveitada (não duplicada):**
- `org.spec.ts`: criação, bloqueio do segundo escritório e alternância; convite; equipe e permissões;
  solicitação por código e cancelamento; remoção com perda imediata de acesso; último administrador;
  troca de usuário; duas abas; perda de "Gerir equipe".
- `deadlines.spec.ts`: isolamento dos prazos pessoais no escritório, URL direta de outro ambiente e
  respostas antigas retidas.
- `intimations.spec.ts`: o mesmo para intimações e notificações.
- `auth.spec.ts`: logout e troca de conta sem dados residuais.

**Modo demo (verificação roteirizada local, fora do CI):** o E2E do projeto roda só o build integrado.
O modo demo foi conferido com um script Playwright **não versionado**, contra o build demo:
- o botão indisponível tem o motivo visível, ligado ao botão por `aria-describedby`, com link para
  `/onboarding`;
- `/app/escritorio` sem vínculo mostra criar e solicitar;
- criar pelo caminho apresentado abre o escritório, e a dica some;
- no pessoal com escritório, "Abrir ambiente do escritório" troca o ambiente;
- em 375 px, a dica aparece no menu.

Resultado: 5 de 5 verificações OK. A lógica que decide o estado é coberta pelo teste unitário, que
roda no CI.

## 7. Validação
Resultados **locais** na árvore validada: commit `65d65c6`, árvore
`cbeda6e4caf507f7af2a87e53ef3456a06956499`, `git status` limpo antes e depois. O commit final só
acrescenta esta seção a este documento. **Não são confirmação do CI**, que não roda sem push.

| Verificação | Resultado (executado) |
|---|---|
| `npm ci` (do zero) | 316 pacotes; Next 15.5.29, Playwright 1.64.1 |
| `npm test` · `typecheck` · `lint` | 303/303 (299 da base + 3 de `office-entry.test.mjs` + 1 gerado automaticamente por `contracts.test.mjs` para o novo `office-entry.d.mts`) · ok · sem avisos |
| Build demo · build integrado (o do E2E) | ok · ok |
| Integração real em memória · em postgres (CI-like) | 45/45 · 45/45 (dados persistidos; capturador vazio) |
| E2E completo, uma execução (`workers: 1`, `retries: 0`) | **69 passed** (65 anteriores + 4 novos); 0 segredos no log; `test-results` vazio |
| E2E focado (`office-entry.spec.ts`) em 3 execuções independentes | 4/4 em cada uma |
| Verificação roteirizada do modo demo (§6) | ver abaixo |
| Backend | **não reexecutado separadamente**: não houve alteração no backend. As integrações e o E2E acima exercitam o FastAPI e o PostgreSQL reais |

**Verificação do modo demo: falha intermitente do script.**
- Na rodada da validação, o script falhou no passo 3: leu `aria-pressed` logo depois da navegação,
  antes de o modo demo aplicar o ambiente salvo, e encontrou o valor antigo.
- Antes disso, ele tinha passado 5/5 uma vez, e passou 5/5 em mais 3 execuções sem alteração.
- O script, que não é versionado, foi corrigido para asserções com espera (`expect` do Playwright,
  sem sleep) e passou 5/5 em 5 execuções seguidas.
- O produto não foi alterado por causa disso.

"CI-like" é o arranjo das entregas anteriores: o Python realocado como no `setup-python` e a
`libpython` do sistema escondida. **Navegador:** Chromium local; a imagem oficial do CI não é
acessível aqui (§8).

## 8. Limitações reais
- A situação exata de quem relatou não é conhecida (§1). As correções cobrem os estados reproduzidos.
- A preferência "pessoal" sobrevive ao ingresso (decisão pendente, §4).
- O modo demo é um protótipo **sem servidor**: convites, códigos e aprovações são simulados no
  navegador. Ele **não** demonstra integrações reais (e-mail, IA, leitura de PDF, banco).
- A verificação do modo demo não roda no CI.
- O E2E usa o Chromium local. A imagem oficial do CI (`mcr.microsoft.com/playwright:v1.64.1-noble`)
  não é acessível neste ambiente.

## 9. Roteiro de apresentação local (~5 minutos, modo integrado, contas fictícias)
**Preparação:** suba PostgreSQL, backend e frontend integrado como em
[22-operacao-recuperacao-senha.md §9.1](22-operacao-recuperacao-senha.md) (recursos descartáveis,
`NEXT_PUBLIC_PRAZOAI_MODE=integrated`). O capturador de e-mail não é necessário aqui. Use duas janelas
anônimas (duas pessoas = duas sessões) e só endereços `@exemplo.com`.

1. **Conta única, ambiente pessoal (1 min).** Janela A: `/cadastro` com "Ana Sócia" e
   `ana@exemplo.com` → "Usar ambiente pessoal".
   - Mostre o seletor "Ambiente: Pessoal" e o item "Escritório" na navegação.
   - Clique em "Escritório": a tela diz que não há vínculo e oferece "Criar escritório" e "Solicitar
     ingresso com código".
   - Em "Prazos" → "Novo prazo", crie um prazo **pessoal** (ex.: "Prazo particular da Ana").
2. **Criar escritório (1 min).** Ainda na janela A: "Escritório" → "Criar escritório" → nome
   "Silva Advocacia" → o seletor passa a "Escritório: Silva Advocacia", e aparecem o código de
   ingresso e o botão de convite. Nenhum login novo foi feito: é a mesma conta.
3. **Privacidade (1 min).** Ainda na janela A:
   - Em "Prazos", no ambiente do escritório, o prazo particular **não** aparece.
   - Troque o seletor para "Pessoal": ele aparece. Trocar de ambiente não transferiu nada.
   - Em "Escritório", com o ambiente pessoal ativo, a tela oferece "Abrir ambiente do escritório".
     Clique e volte ao escritório.
4. **Ingresso por código (1,5 min).** Janela B: `/cadastro` com "Caio Membro" e `caio@exemplo.com`
   → "Usar ambiente pessoal".
   - Em "Escritório" → "Solicitar ingresso com código", digite o código mostrado na janela A.
   - Na janela A, recarregue "Escritório" → "Aprovar" (confirmar).
   - Na janela B, abra "Escritório" → "Abrir ambiente do escritório": Caio vê o escritório **como
     membro**, sem convites nem código.
   - Em `/solicitar-ingresso`, Caio é avisado de que já pertence a um escritório (segundo vínculo
     recusado).
5. **Saída (0,5 min).** Janela B: "Equipe" → "Sair do escritório" → confirmar. O seletor volta a ter
   só "Pessoal", e "Escritório" volta a oferecer criar ou solicitar.

**Encerramento:** apague os recursos descartáveis como em doc 22 §9.1. Para o **modo demo**, basta o
build sem `NEXT_PUBLIC_PRAZOAI_MODE`. Lá tudo é fictício e fica no navegador, e isso deve ser dito ao
apresentar.
