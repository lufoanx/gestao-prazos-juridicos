# 11 — Etapa 6.2: Onboarding, ambientes, escritório, equipe, convites e solicitações (modo integrado)

> **Estado:** integrados no modo `integrated` (BFF + FastAPI, ainda em memória). Prazos, calendário,
> intimações e notificações continuam **não integrados** e sem dados demonstrativos. Nenhuma
> mudança de backend foi necessária: todos os contratos usados já existiam (Etapa 3).

## 1. Telas e rotas integradas
| Rota | Fluxo |
|---|---|
| `/onboarding` (e `/onboarding/*`) | ambiente pessoal (sempre existe) ou criação de escritório; bloqueio de segundo escritório |
| `/app` | resumo do ambiente; atalhos de onboarding quando não há escritório |
| `/app/escritorio` | dados do escritório, código de ingresso, convites, solicitações do escritório |
| `/app/escritorio/equipe` | membros (projeção pública/administrativa), edição, promoção, remoção, saída |
| `/convite#TOKEN` | consulta pública, autenticação na própria tela, confirmação e aceite |
| `/convite/<qualquer coisa>` | formato antigo → página explicativa (`/convite-antigo`), **sem chamar a API** |
| `/solicitar-ingresso` | pedido por código, lista e cancelamento das próprias solicitações |

Demais rotas de `/app/*` continuam reescritas para "Módulo ainda não integrado". O cadastro
integrado agora leva ao onboarding.

## 2. Ambientes
- **Pessoal** sempre existe; "autônomo" não é entidade nova. Entrar em escritório **não** transfere
  dados pessoais; não há migração de `localStorage` nem transferência automática.
- A seleção de ambiente (cabeçalho, "Ambiente") é **contexto de navegação, nunca autorização**. Só a
  preferência `personal`/`office` é guardada em `sessionStorage`, por aba e por usuário, para
  sobreviver a recarregamentos. Nenhum `officeId` ou permissão é guardado: o escritório só aparece
  se `GET /memberships/me` confirmar o vínculo atual.
- O vínculo é atualizado ao recuperar foco ou visibilidade da aba, após mutações relevantes, por
  aviso de outra aba (`BroadcastChannel("prazoai-org")`, que só pede ressincronização) e após
  403/404 em recursos do escritório. 403/404 **não** viram logout.

## 3. Equipe e matriz refletida na interface
Os controles aparecem conforme as permissões **atuais** do vínculo; o servidor decide de verdade.
- O cargo é rótulo visual e a interface diz isso. `createdBy` e cargo não concedem poderes.
- "Editar" só aparece para quem tem `team.manage`, nunca para si e, para gestores sem privilégio
  administrativo, nunca sobre outros gestores ou administradores.
- No formulário, só as permissões que o ator possui ficam habilitadas; `team.manage` e
  `office.manage` exigem administrador; "todos os prazos" exige que o ator tenha essa visibilidade.
- **Solicitações:** "Aprovar" exige `team.manage` e todas as permissões de ingresso (mesma regra
  do backend, `can_grant_entry`); "Rejeitar" exige apenas `team.manage` (`can_manage_team`). Um
  gestor com `deadline.read` + `team.manage` lista e rejeita, mas não aprova.
- "Promover a administrador" só para administradores. O último administrador é preservado pelo
  servidor: a saída sem sucessor recebe 409 `successor_required` e a tela pede o sucessor.
- **Reatribuição:** a API não oferece um resumo de responsabilidades. A interface **não** inventa
  contagens. Se o servidor responder 409 `reassign_required`, a tela explica que há
  responsabilidades em aberto e pede o destino (`reassignTo`). O novo envio é sempre uma ação
  explícita do usuário.
- Mutações nunca são repetidas automaticamente; em erro, o formulário é preservado.

## 4. Convites
- O link tem o formato `/convite#TOKEN`, montado no navegador a partir da resposta da criação e
  exibido **uma vez**, só em memória. A tela diz claramente que **nenhum e-mail é enviado**.
- Na abertura, o token é lido do fragmento, guardado em memória e o fragmento é **removido da
  barra** (`history.replaceState`, sem navegação nem requisição). O token só trafega no **corpo**:
  `POST /bff/public/invitations/lookup` e `POST /bff/api/invitations/accept`. Não vai para
  pathname, query, redirect, logs ou storage persistente.
- Sem sessão, login e cadastro aparecem **embutidos na própria tela** (sem navegar, então o token
  não se perde). O aceite exige confirmação explícita.
- Estados: válido, expirado, revogado, utilizado (`used`) e inválido. Quem já tem escritório vê
  o bloqueio (um escritório por pessoa).
- Links antigos `/convite/<token>`: o navegador ainda envia esse caminho ao servidor do Next, mas
  ele é reescrito para uma página estática e o token **nunca** é encaminhado à API.

## 5. BFF
- **Allowlist ampliada só com o necessário** (`src/server/bff/allowlist.mjs`): vínculo,
  escritório, equipe, código de ingresso, convites (lista/criação/revogação/aceite) e solicitações.
  Segmentos dinâmicos `:id` validados (`[A-Za-z0-9_-]{1,64}`). Query strings não são repassadas.
  Rotas de módulos futuros continuam fora (404).
- **Consulta pública de convite** em rota própria (`/bff/public/invitations/lookup`): não usa
  sessão, não altera cookies, exige o cabeçalho próprio e `Origin`, aceita apenas `{ token }` e não
  registra nada em log. O proxy autenticado **não** virou proxy aberto.
- Mantidos: destino fixo, cabeçalhos reconstruídos, limites de corpo e tempo, `no-store`, tokens
  de autenticação só no servidor, nenhuma repetição de mutação.
- A resposta de criação de convite traz o token do **convite** (não de autenticação), necessário
  para montar o link; ele não é registrado em log.
- Limites de taxa: sem fonte de IP verificável, consultas e aceites de convite ficam limitados pelo
  IP do BFF (compartilhado). Nada foi afrouxado para os testes.

## 6. Estado e isolamento

**Revisão de autorização (correção da auditoria).** O controlador de vínculo mantém `revision`, que
incrementa a cada troca de usuário, troca de escritório, perda de vínculo ou mudança de permissões
ou visibilidade. Ela entra:
- nas **chaves de cache** (`u:…|o:…|s:…|r:<revisão>|<recurso>`): dados de outra revisão nunca são
  servidos;
- na **chave de remontagem** do conteúdo de `/app`: dados renderizados, formulários abertos (por
  exemplo, a edição de um membro) e seleções incompatíveis são descartados, e as consultas são
  refeitas com a autorização atual;
- no hook `useResource`, que guarda a chave a que cada resultado pertence. Ele nunca devolve dados
  de outra chave, nem no render intermediário, e só aplica ou cacheia uma resposta se ela ainda
  pertence à chave vigente.

A mudança de revisão também incrementa a época do cliente HTTP, abortando requisições pendentes.
Uma resposta antiga (pausada) não repovoa estado nem cache. Na equipe, e-mails, permissões e
visibilidade só aparecem com projeção administrativa **e** `team.manage` atual. 403/404 continuam
revalidando o vínculo, sem logout.

- Fontes separadas dos contextos demonstrativos: `AuthProvider` → `OrgProvider`
  (`org-controller.mjs`) → hook `useResource` com cache (`query-cache.mjs`).
- Chaves de cache: `u:<usuário>|o:<escritório>|s:<ambiente>|<recurso>`. O cache é limpo ao trocar
  de usuário, sair, perder o vínculo, mudar de escritório ou mudar permissões/visibilidade.
- Toda mudança de vínculo incrementa a época do cliente (respostas antigas descartadas); respostas
  antigas do próprio vínculo também são ignoradas por sequência.
- O conteúdo de `/app` é remontado (chave `usuário|escritório|ambiente`), de modo que nenhum dado
  do escritório anterior sobrevive à remoção, à saída ou à troca de usuário.

## 7. Testes
| Tipo | Arquivo |
|---|---|
| Unitários com dublês | `frontend/tests/org-integration.test.mjs` (allowlist, consulta pública, cliente, token do convite, capacidades/delegação, controlador de vínculo, preferência de ambiente, cache) |
| Integração real (BFF × FastAPI) | `frontend/tests/integration/org-backend.test.mjs` |
| E2E (navegador + Next integrado + FastAPI) | `frontend/e2e/org.spec.ts`; o teste que derruba o backend foi para `e2e/zz-backend-down.spec.ts`, para rodar por último |

Usuários diferentes usam contextos de navegador distintos; abas do mesmo contexto compartilham a
sessão. As responsabilidades em aberto dos testes de remoção são criadas pela API **existente** de
prazos do backend, com contas de teste; nenhuma rota de módulo futuro foi aberta no BFF.

## 8. Limitações
- Tudo em memória (BFF e backend); um processo; perda ao reiniciar; não publicar.
- Sem e-mail: links de convite são copiados e enviados manualmente.
- Sem resumo de responsabilidades na API (ver §3).
- O caminho `/convite/<token>` antigo ainda chega ao servidor do Next antes da reescrita.
