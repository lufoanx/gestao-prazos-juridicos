# 25 — Estabilidade do botão "Gerar link de convite" (deslocamento de layout)

> **Tipo de entrega:** correção isolada do frontend (tela integrada do escritório), com teste E2E e
> documentação. Não inclui backend, contratos, BFF, dependências, migrations, funcionalidades novas,
> ajustes de fuso nem liberação de produção.
>
> **Base:** `main` `6dbbf9ebfe9394e0ebbf0c8707a1613b4cc74a65` (merge do PR #30), árvore
> `d1483c2f7053e0933ec84b76e481fcd61e27ec6b`, CI pós-merge `44618015958` verde nos quatro jobs
> (conferido pela API do GitHub). Branch `fix/convite-deslocamento`. Diagnóstico original: doc 21 §17.2.

## 1. Duas coisas diferentes
- **Mecanismo reproduzido (comprovado nesta entrega):** se a resposta do código de ingresso chega entre o
  *pressionar* e o *soltar* do botão do mouse, o cartão acima cresce, o botão desce, e o clique é perdido:
  nenhum `submit`, nenhum `POST`, nenhum link (§2).
- **Falha histórica do E2E (`deadlines.spec.ts:103`, doc 21 §17.2):** a causa daquela execução **não foi
  comprovada**, porque não havia rastreamento de rede. O mecanismo acima é a única hipótese compatível com
  o instantâneo daquela falha. A reprodução desta entrega **não prova retroativamente** que foi isso.

## 2. Reprodução na base (executada, navegador real)
Ambiente: build integrado do Next, BFF e FastAPI reais, PostgreSQL e Mailpit locais descartáveis,
Chromium local. Uma spec **temporária**, não versionada, retém a resposta **verdadeira** do servidor
para `GET /bff/api/offices/:id/join-code` (`route.fetch()` → gate → `fulfill`). O gate é uma promessa
liberada pelo próprio teste, sem sleep.

Passos:
1. Esperar que a leitura esteja retida e que a lista de convites esteja pronta.
2. Rolar até o botão e confirmar, com `elementFromPoint`, que o ponto central é o botão.
3. `mouse.down()` nesse ponto.
4. Liberar a resposta e esperar o código aparecer.
5. Conferir de novo o ponto e fazer `mouse.up()` no mesmo lugar.

Contadores no documento, instalados antes da página, medem `submit` e `click` no botão; a rede é
observada pelos `POST` de convite.

| Execução (base `6dbbf9e`) | Deslocamento do botão | Alvo sob o cursor (antes / depois) | `submit` | clique no botão | `POST` | link |
|---|---|---|---|---|---|---|
| desktop 1280×800 (3/3) | **65 px** | sim / **não** | 0 | 0 | 0 | não |
| tela estreita 360×740 (3/3) | **135 px** | sim / **não** | 0 | 0 | 0 | não |

O navegador entrega `click` só quando `mousedown` e `mouseup` caem no mesmo elemento. Aqui o `click` vai
para um ancestral comum e o formulário não é enviado. Um clique humano no mesmo instante tem o mesmo
efeito: o problema é do produto, não só do teste.

## 3. Causa do deslocamento
Na tela `/app/escritorio` (`frontend/src/integrated/IntegratedOffice.tsx`), o cartão "Código de ingresso"
fica **acima** do cartão "Convites" e carrega o código de forma independente:

| Estado | O que o cartão mostra |
|---|---|
| carregando | uma linha ("Carregando…") |
| pronto | o código, o texto explicativo e o botão "Gerar novo código" (2 a 5 linhas, conforme a largura) |
| erro | a mensagem e o botão "Tentar novamente" |

Cada troca muda a altura do cartão e desloca tudo o que está abaixo, inclusive o botão de convite.
O "Dados do escritório", acima, não tem carregamento próprio. A lista de convites e as solicitações
ficam **abaixo** do botão e não o deslocam.

## 4. Solução escolhida
**Reservar o espaço do conteúdo pronto enquanto o código não chega** (`IntegratedOffice.tsx` e
`globals.css`):
- O corpo pronto virou um componente (`JoinCodeBody`) reutilizado em duas formas:
  - **real**, com o código, `data-testid="join-code"`, o botão funcional e as mensagens de rotação;
  - **reserva**, com um marcador de mesmo comprimento do código (10 caracteres monoespaçados,
    `JOIN_CODE_LENGTH` do backend) e o botão desabilitado.
- `.stable-slot` (CSS grid) põe a reserva e o estado atual **na mesma célula**. A altura é a **maior** das
  duas, então um conteúdo maior (erro longo, tela estreita) expande o cartão em vez de ser cortado.
  Não há altura fixa, `overflow: hidden` nem posicionamento absoluto.
- A reserva só existe enquanto o recurso **não está pronto**. Ela é `visibility: hidden` (fora da ordem de
  foco e da árvore de acessibilidade), `aria-hidden` e sem eventos de ponteiro. Pronto o recurso, a
  reserva sai e o conteúdo real ocupa a mesma altura, porque tem a mesma estrutura e as mesmas quebras de
  linha.
- A indicação "Carregando…" (`aria-busy`) e o erro com "Tentar novamente" continuam visíveis por cima do
  espaço reservado, sem mudança no componente `ResourceState`.

**Preservado:** permissões e capacidades da tela, geração e revogação de convites, rotação do código
(confirmação, mensagens), tratamento de erros, foco e teclado. O botão de convite **funciona durante o
carregamento**: o `POST` não depende do código de ingresso. Por isso a pessoa não clica num controle
aparentemente disponível que ignora a ação.

**Alternativas descartadas:**
- *Só mudar o teste para esperar o código:* esconderia o problema e manteria o clique perdido para pessoas.
- *Altura fixa ou `min-height` em pixels:* não acompanha a quebra de linha da tela estreita (65 px ×
  135 px). Cortaria ou sobraria conteúdo e quebraria com mensagens de erro maiores.
- *Desabilitar o botão de convite até o código chegar:* criaria uma dependência que não existe e
  atrasaria uma ação válida.
- *Reordenar os cartões (convites antes do código):* mudaria a página e só transferiria o problema para
  o botão "Gerar novo código", que ficaria abaixo da lista de convites, também carregada de forma assíncrona.

**Helper `joinByInvite` (E2E): não alterado.** A correção está no produto. Manter o helper sem espera
extra faz o E2E de prazos continuar exercitando a corrida real, agora inofensiva, em vez de contorná-la.

## 5. Testes (`frontend/e2e/invite-layout.spec.ts`)
As rotas interceptadas **só retêm a resposta verdadeira** (BFF + FastAPI reais) para impor a ordem.
A exceção é o teste de erro, que **simula** uma falha de rede com `route.abort("failed")`. Não há sleep,
`force`, retries nem timeout aumentado. As falhas não imprimem link, token, cookie nem corpo: as
asserções usam contagens, posições e textos fixos da interface.

| Teste | O que prova | Base `6dbbf9e` | Com a correção |
|---|---|---|---|
| `convite (desktop)`: código chega entre mousedown e mouseup | botão não se move; alvo utilizável sob o cursor antes e depois; `submit` 1, clique 1, **exatamente um `POST`**, link exibido, lista recarregada com um convite "Válido" | **falha** (65 px) | passa |
| `convite (tela estreita)` (360×740) | idem | **falha** (135 px) | passa |
| carregamento lento do código **e** da lista | clique durante a espera gera o link com o código ainda "Carregando…"; depois o botão continua no lugar; um `POST` | **falha** (65 px) | passa |
| erro na leitura do código (rede simulada) | erro com "Tentar novamente" não desloca o botão; o clique gera o link; a nova tentativa mostra o código sem mover o botão | **falha** (25 px) | passa |
| teclado (Tab + Enter, tela estreita, código carregando) | foco chega ao botão; Enter gera um `POST` e o link | passa (o teclado não depende da posição) | passa |
| fluxo normal sem retenção | código único (a reserva some), um "Gerar novo código", um `POST`, link | passa | passa |

O fluxo normal de convite, aceite, revogação e o código de ingresso continuam cobertos por
`e2e/org.spec.ts` e pelo `joinByInvite` das specs de prazos e intimações, sem alteração.

Também conferi visualmente, em capturas não versionadas (desktop e 360 px): carregando, pronto e erro com o
botão na mesma posição, sem sobreposição nem corte.

## 6. Validação
Resultados **locais**, executados na árvore validada: commit `c7d326e`, árvore
`05b3dd245ab25a698152540c4a8c9087be04f9f0`, `git status` limpo antes e depois. O commit final só
acrescenta esta seção a este documento (§9). **Não são confirmação do CI**, que não roda sem push.

| Verificação | Resultado (executado) |
|---|---|
| `npm ci` (do zero) | 316 pacotes; Next 15.5.29, Playwright 1.64.1 |
| `npm test` · `typecheck` · `lint` | 299/299 · ok · sem avisos |
| Build demo (`npm run build`) | ok |
| Build integrado (o do E2E: `next build` com a configuração integrada) | ok |
| Integração real em memória (CI-like) | 45/45 |
| Integração real em postgres (CI-like) | 45/45; dados persistidos; capturador vazio ao final |
| E2E completo, uma execução (`workers: 1`, `retries: 0`) | **65 passed** (59 anteriores + 6 novos); 0 segredos no log; `test-results` vazio |
| Teste focado repetido 5 vezes (5 execuções independentes, não repetição automática de falhas) | 6/6 passed em cada uma |
| Backend (sem alteração; reexecutado como no CI): `pip check`, pytest completo com PostgreSQL e Mailpit obrigatórios, suítes HTTP em postgres, ciclo de migrations e manutenção, Ruff, MyPy sem cache, `compileall` | ok; 1023 passed, 1 skipped; 470 passed, 24 skipped; ok; ok; ok; ok |

"CI-like" é o mesmo arranjo das entregas anteriores: o Python realocado como no `setup-python` e a
`libpython` do sistema escondida. **Navegador:** Chromium local pré-instalado. A imagem oficial do
CI (`mcr.microsoft.com/playwright:v1.64.1-noble`, alinhada ao Playwright 1.64.1 do `package-lock`) não é
acessível neste ambiente. Não foi alterada nem substituída na configuração.

## 7. Limitações
- A reserva usa o comprimento atual do código (10). Se o backend mudar `JOIN_CODE_LENGTH`, a reserva
  fica alguns caracteres maior ou menor: um deslocamento pequeno, sem corte nem clique perdido garantido.
- As mensagens após **girar** o código ("Novo código gerado." ou erro) aparecem dentro do cartão e
  aumentam sua altura. É uma consequência de uma ação da própria pessoa no cartão, não de carregamento;
  não foi tratada.
- Nos estados "sem permissão" ou "outro ambiente", que substituem o carregamento, o cartão mantém a
  altura reservada, com espaço em branco abaixo do aviso.
- Outras telas com cartões carregados de forma assíncrona acima de botões não foram alteradas; esta
  entrega trata só o caso diagnosticado.
- Navegador: localmente foi usado o Chromium pré-instalado. A imagem oficial do CI
  (`mcr.microsoft.com/playwright:v1.64.1-noble`) não é acessível neste ambiente, então o resultado
  local **não é confirmação do CI**.

## 8. Explicação curta para o TCC
Um botão só recebe o clique se o mouse for pressionado **e** solto sobre ele. Na tela do escritório, o
cartão do código de ingresso, acima do botão "Gerar link de convite", crescia quando seu conteúdo
chegava. Se isso acontecia no meio do clique, o botão "fugia" do cursor e nada acontecia. Reproduzimos o
fenômeno de forma determinística, segurando a resposta real do servidor até o momento exato. A correção
reserva desde o início o espaço que o conteúdo vai ocupar, com uma cópia invisível do próprio conteúdo,
para que nada abaixo se mova. Um teste automatizado no navegador repete o clique no mesmo instante
crítico e exige exatamente um envio e o link na tela.

## 9. Artefatos
- Base `6dbbf9e` (árvore `d1483c2f`). Commits: `2b203ae` (correção e E2E), `c7d326e` (docs) e o
  commit que acrescenta o §6.
- ZIP limpo (`git archive`), diff e patch sobre a base. Os três reproduzem a árvore do commit final, sem
  segredos, dependências, builds ou caches.
- **Sem push, PR, merge ou implantação.**
