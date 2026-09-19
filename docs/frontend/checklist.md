# Etapas e critérios de aceite
Estado inicial: base pronta; nenhuma tela de produto concluída.
- [~] 1. Shell, tokens, componentes e dashboard; **aguardando aprovação visual de Lucas**.
      Feito: sistema de tokens + estilos (globals.css); biblioteca de componentes
      (Button, Badge, Avatar, Input/Select/Textarea, Tabs, Pagination, Table ordenável,
      Modal, ConfirmDialog, Drawer, Toast, EmptyState, Skeleton, Breadcrumb, Filters,
      ScopeSwitcher); casca (Sidebar/Header/AppShell) com alternância Pessoal/Escritório
      muito visível; Dashboard (/app/dashboard) com urgentes, agenda do dia, intimações
      para revisão e visão geral — contadores derivados das MESMAS listas.
      Estados: vazio (EmptyState) e sucesso/aviso (Toast) exercitados; sem botão morto
      (links levam a placeholders reais). Acessibilidade: skip-link, foco visível,
      foco preso no modal, Escape, aria em abas/tabela/switch, nunca só cor.
      Simulado (rotulado no dashboard): urgência = agrupamento visual, não cálculo oficial;
      sem IA/e-mail/leitura de PDF; dados fictícios; "encerrar sessão" é simulação.
      Ajustes pós-feedback (direção aprovada como base): logo branca no fundo azul e
      azul no fundo claro; conteúdo mais largo (max 1640px) e textos secundários maiores;
      ações principais "Novo prazo" e "Enviar intimação" (e "Gerenciar escritório"
      conforme vínculo + permissões); banda de prioridade destacando urgentes, agenda
      do dia e intimações; visão geral rebaixada a seção secundária; aviso demonstrativo
      compacto (chip de uma linha). Prévias desktop e mobile geradas para aprovação.
      Refinamento 2 (direção mantida): logo branca maior no menu (38px); banda de
      prioridade em duas colunas — urgentes ~2/3, agenda do dia + intimações empilhadas
      no 1/3 — colapsando para uma coluna em telas menores; títulos com clamp de 2 linhas
      e número de processo/tribunal sem quebra (nowrap), metadados mais espaçados; coluna
      de vencimento com largura mínima. Gestão de escritório ocultada no ambiente pessoal
      (sidebar e ação do dashboard só no escopo escritório, respeitando permissões).
      Gates: `npm test` 20/20 · `npm run build` OK · `npm run typecheck` OK.
      Pendente: aprovação do Lucas antes de replicar o padrão às demais telas.
- [~] 2. Landing, acesso, Google demo, recuperação, onboarding e convites.
      Feito: landing (/) com hero, demonstração visual, recursos, como funciona,
      autônomo/escritório, FAQ e CTA (sem métricas/depoimentos inventados); /login e
      /cadastro (validação, mostrar senha, Google demonstrativo via diálogo — nunca OAuth
      real; cadastro só em memória, sem pedir OAB no início); /esqueci-senha (envio neutro,
      sem enumeração de conta) e /redefinir-senha/[token] (estados válido/expirado/usado/
      inválido/sucesso via tokens demo); /onboarding (escolher autônomo, criar escritório
      ou ingressar), /onboarding/autonomo e /onboarding/escritorio; /solicitar-ingresso
      (código do escritório rotulado como PROPOSTA — pendência #2 — com estado pendente).
      Logo do menu ampliada (46px), proporção/contraste preservados; logo azul em fundo
      claro nas telas públicas. Índice técnico movido para /dev.
      Simulado e rotulado: sem autenticação/OAuth/e-mail reais; nada persistido.
      Deferido (fora do pedido atual, política não aprovada): /convite/[token] (convites,
      pendência #1).
      Estado demonstrativo compartilhado (SessionContext + localStorage versionado,
      chave prazoai:demo-session): guarda nome, e-mail, perfil, preferências e escritório
      criado/ingressado — NUNCA senhas (transições puras em src/lib/session.mjs, cobertas
      por testes). Dashboard e casca refletem a sessão: cadastro/login preenchem nome/e-mail;
      autônomo fica SEM escritório; criador entra como ADMINISTRADOR do escritório criado;
      convite por link (/convite/[token]: estados válido/expirado/revogado/usado/inválido)
      faz ingressar como MEMBRO, respeitando NO MÁXIMO UM escritório por pessoa
      (already-member / second-office) e preservando os prazos pessoais como privados.
      Encerrar sessão limpa o estado e volta ao login. Design aprovado preservado.
      Correções de consistência: criar escritório é BLOQUEADO com vínculo ativo
      (canCreateOffice/applyCreateOffice — nunca substitui em silêncio; a tela mostra
      estado de bloqueio); login com e-mail diferente NÃO herda nome, preferências nem
      escritório da sessão anterior (mesmo e-mail preserva). Restauração via localStorage
      validada por versão e round-trip.
      Gates: `npm test` 37/37 · `npm run build` OK (15 rotas) · `npm run typecheck` OK.
      Pendente: validação de Lucas em localhost.
- [x] 3. Lista/calendário/cadastro/edição/detalhes/conclusão/comentários/anexos/histórico.
      PRÉ-REQUISITO CONCLUÍDO: IDs próprios (src/lib/ids.mjs) — usuário derivado do
      e-mail (userIdFromEmail) e escritório do dono+nome (officeIdFor). Removido o
      CREATED_OFFICE_ID fixo; DEMO_USER_ID mantido só como persona semeada da visita
      direta. Isso impede mistura de dados entre contas ao persistir.
      Dados compartilhados + persistência demonstrativa: DataProvider (src/context/
      DataContext.tsx) com localStorage "prazoai:demo-data:v1" (versionado), mesclando
      sementes + registros criados (persistido vence por id; cópia-na-escrita ao editar
      semente). Ações: criar/editar/concluir/reabrir/cancelar prazo, comentar, anexar
      (demonstrativo)/remover — cada uma grava histórico (audit) e notificações em
      criar/concluir. Dashboard, lista, calendário e sino do header leem do store, então
      refletem cada ação. Nenhuma senha é persistida.
      Telas (sob a casca /app, design aprovado preservado): /app/prazos (busca, filtros
      status/urgência/área, paginação PER_PAGE=8, tabela ordenável), /app/prazos/novo,
      /app/prazos/[id] (detalhes + conclusão/cancelamento/reabertura + comentários +
      anexos demonstrativos + histórico), /app/prazos/[id]/editar, /app/calendario
      (grade mensal 6×7, navegação, cores por urgência/status). Placeholder /app/[...rest]
      dentro da casca evita 404 nos links ainda não implementados.
      Isolamento Pessoal/Escritório via matchesScope + canReadDeadline; permissões via
      canManageDeadline (pessoal sempre; escritório exige deadline.create/edit/complete).
      SEM cálculo jurídico oficial: a data de vencimento é informada manualmente; contagem
      e duração são apenas organizacionais (rótulos no formulário).
      Módulos puros testáveis: src/lib/deadlines-view.mjs (matchesScope, filter, sort,
      paginate, distinctAreas, monthMatrix, groupByDueDate).
      Reforços de segurança da camada de dados: guarda compartilhada em
      src/lib/deadline-guards.mjs (OP_PERMISSION, canWriteDeadline, canCreateDeadline,
      canPerformOp) — fonte única usada por src/lib/data-ops.mjs (operações puras) e
      pelos testes. O DataContext apenas delega às operações puras. Guardas de escopo +
      leitura + permissão em criar/editar/concluir/cancelar/reabrir/comentar/anexar/
      remover; bloqueio retorna o MESMO estado (sem alterar dados nem histórico). Patch
      de edição passa por whitelist (sanitizePatch) — id, escopo e status não mudam por
      patch. Alinhamento tela↔dados: cancelar/concluir/reabrir exigem deadline.complete
      (a tela deriva a permissão de OP_PERMISSION). Hidratação corrigida em Session/
      DataContext: só grava após ler o localStorage. Restauração valida a estrutura
      completa: sanitizeStored (dados) e isValidSession reforçado (usuário, escritório,
      perfil, preferências, vínculo, permissões conhecidas, visibility e coerência
      membership↔office↔user); dados corrompidos são descartados sem quebrar.
      Gates: `npm test` 70/70 · `npm run build` OK (22 rotas) · `npm run typecheck` OK.
      Pendente: validação de Lucas em localhost.
  - Etapa 4 (intimações + notificações) — CONCLUÍDA no código:
      Telas (design preservado, sem ajustes visuais): /app/intimacoes (busca, filtro por
      status, estados), /app/intimacoes/upload (arrastar/soltar PDF, validação de
      formato/tamanho, remoção, estados processando/sucesso/erro + nova tentativa),
      /app/intimacoes/[id]/revisao (revisão OBRIGATÓRIA de processo/tribunal/título/área/
      responsável/datas, corrigível antes de confirmar), /app/notificacoes (filtros
      todas/não lidas/lidas, marcar uma ou todas). Drawer do header ganhou marcar
      uma/todas + "ver todas"; contador do sino sincronizado (deriva de useData).
      Extração SIMULADA e rotulada: não há IA/OCR/e-mail/cálculo real; os dados sugeridos
      NÃO derivam do PDF e exigem conferência humana. Nenhum prazo é criado antes da
      confirmação. A confirmação cria UM único prazo vinculado à intimação, com histórico
      e notificação, e proteção contra duplicação (status reviewed / deadlineId).
      Camada de dados: novas ops puras em data-ops.mjs (opUploadIntimation, opProcess-
      Intimation, opRetryIntimation, opRemoveIntimation, opConfirmIntimationReview,
      opMarkNotificationRead, opMarkAllNotificationsRead), guardas de intimação em
      deadline-guards.mjs (canAccessIntimation/canWriteIntimation), isolamento Pessoal/
      Escritório + permissões (deadline.create) aplicados na camada de dados. Persistência
      demonstrativa estende o store (intimations + removedIntimationIds); sanitizeStored
      valida e restaura intimações. Dashboard/lista/calendário refletem o prazo criado.
      Reprocessamento centralizado: componente IntimationProcessor montado na casca
      (dentro do DataProvider) resolve qualquer intimação em "processing" acessível no
      ambiente atual, com atraso — funciona após navegar OU recarregar e nunca deixa
      intimação presa em "processing". O desfecho (sucesso/falha) é persistido em
      demoForceFail; "Tentar novamente" limpa a falha e reprocessa de verdade até
      sucesso/erro. Isolamento preservado no assíncrono (só resolve o que o contexto
      atual pode escrever; troca de ambiente cancela timers). Upload e revisão são
      reativos ao store (sem timers próprios).
      Gates: `npm test` 83/83 · `npm run build` OK (26 rotas) · `npm run typecheck` OK.
      Pendente: validação de Lucas em localhost.
  - Etapa 5 (escritório/equipe/permissões/convites/solicitações/transferência/saída) — CONCLUÍDA no código:
      Registro compartilhado e persistido independente da sessão (OrgContext, chave
      prazoai:demo-org:v1) com reconciliação: o escritório criado persiste após logout;
      equipe/convites/solicitações não dependem só da sessão. ScopeContext usa o roster
      como fonte da verdade (criar/entrar/sair/ser removido e mudanças de permissão
      refletem imediatamente). Operações puras em org-ops.mjs (fonte única do OrgContext
      e dos testes); bloqueios retornam o MESMO estado.
      Telas (design preservado): /app/escritorio (dados: ver/editar por office.manage,
      código do escritório copiável, sair do escritório com regra de último admin →
      transferir antes) e /app/escritorio/equipe (abas Membros/Convites/Solicitações:
      cargo/áreas/permissões/visibilidade all|assigned, remover com reatribuição
      obrigatória de prazos em aberto, gerar/copiar link único, revogar, aprovar/rejeitar).
      Regras: escritório único por pessoa; sem auto-escalada de permissões; escritório
      nunca sem administrador. Responsáveis nos formulários de prazo e revisão vêm do
      roster do escritório. Transferência pessoal→escritório na tela do prazo (confirmação
      de compartilhamento; mesmo id; comentários/anexos/histórico preservados; intimação
      vinculada acompanha; registra "transferred"; não duplica). Convites gerados conectam
      à rota /convite/[token] (sem e-mail); solicitar-ingresso usa o código (id) do
      escritório. Saída retira o acesso; prazos pessoais continuam privados; após sair,
      pode ingressar em outro. Sem backend/sincronização entre dispositivos.
      Testes: org-ops.test.mjs + transferência em data-ops.test.mjs.
      Correções (fonte única + remoção transacional): vínculo unificado — sair/ser
      removido registra tombstone (leftKeys) e a reconciliação não ressuscita vínculos
      encerrados; leaveOffice limpa também a sessão (applyLeaveOffice/clearOffice);
      criação consulta o roster (myOfficeMembership) impedindo dois escritórios mesmo
      após logout/login; após sair, pode criar/ingressar em outro sem restaurar o antigo
      no refresh. Remoção transacional na operação: validateRemoveMember (org-ops) exige
      reatribuição para membro ativo do mesmo escritório antes de remover; reatribuição
      via opReassignResponsibleForOffice (data-ops) move só prazos em aberto do escritório
      e NÃO exige deadline.edit (ação de gestão de equipe). Se qualquer verificação falha,
      nada muda e não há mensagem de sucesso.
      Testes adicionais: saída→tombstone→sem ressurreição; saída→ingresso em outro
      escritório; remoção sem restauração do vínculo; validateRemoveMember (todos os
      casos); reatribuição sem deadline.edit; applyLeaveOffice limpa a sessão.
      Gates: `npm test` 106/106 · `npm run build` OK (28 rotas) · `npm run typecheck` OK.
      Pendente: validação de Lucas em localhost.
  - Etapa 5 (robustez final) — CONCLUÍDA no código:
      Saída atômica: opLeaveOrTransferOffice (org-ops) transfere+sai numa unidade;
      OrgContext.leaveOffice retorna {ok,reason} e só limpa a sessão quando a saída
      conclui — bloqueio do último administrador preserva sessão e vínculo e devolve o
      motivo à tela. Remoção coordenada: team-ops.coordinateRemoveMember valida
      permissão, último admin, prazos em aberto e destinatário ativo do mesmo escritório
      e devolve ambos os estados; em falha nada muda (identidade preservada). Hook
      useTeamActions aplica reatribuição + remoção via reducers centralizados só após
      validar; sucesso só depois de concluir as duas mudanças. Reatribuição não exige
      deadline.edit.
      Testes: team-ops.test.mjs (remove+reatribui; gestor sem deadline.edit; destinatário
      inválido; sem reatribuição; sem team.manage; sem prazos em aberto) + saída atômica
      em org-ops.test.mjs (último admin bloqueado sem sucessor; transfere+sai com sucessor
      válido; sucessor inválido; membro comum).
      Gates: `npm test` 117/117 · `npm run build` OK (28 rotas) · `npm run typecheck` OK.
      Pendente: validação de Lucas em localhost.
  - Etapa 6 (perfil/configurações/assistente) — CONCLUÍDA no código:
      Perfil (/app/perfil): edita nome + área preferida com validação e feedback; o nome
      atualiza o cabeçalho na hora (applyUpdateProfile/updatePreferences). E-mail é âncora
      de identidade (somente leitura, evita misturar dados). "Alterar senha" é
      demonstrativo — nada é armazenado.
      Configurações (/app/configuracoes): persistência por usuário (prazoai:demo-settings:v1,
      SettingsContext). Efeitos REAIS: densidade (compacta), reduzir animações, mostrar
      concluídos por padrão na lista. Alertas por e-mail/digest/antecedência ficam salvos
      mas rotulados como DEMONSTRATIVOS (dependem de backend). Density/reduce-motion são
      aplicados por classe em ShellChrome.
      Assistente (/app/assistente): chat com sugestões, envio, carregamento, respostas
      SIMULADAS e limpar conversa; conversa persiste por usuário. Foco em organização de
      prazos e uso da PrazoAI; banner deixa claro que não há IA real, orientação jurídica
      nem cálculo processual. Contagens (abertos/próximos/vencidos/revisões) vêm do
      ambiente ATIVO filtrado por escopo + permissão (canReadDeadline + buildDashboard).
      Simulação isolada em src/lib/assistant.mjs (motor puro) — pronta para trocar por
      backend. Navegação: adicionado item Perfil. Estados vazios, acessibilidade
      (aria-live no log, labels) e responsividade cobertos.
      Testes: stage6.test.mjs (assistente por contexto + fallback/disclaimer; settings
      padrão/sanitização/merge; perfil nome≠e-mail e merge de preferências).
      Correções: histórico do assistente isolado por usuário E ambiente (chave
      usuário|ambiente; mensagens viajam com a própria chave — nunca gravadas na chave
      nova); respostas pendentes canceladas ao trocar conta/ambiente, limpar ou sair
      (timer com guarda de chave); contagens do assistente aplicam permissões às
      intimações (canAccessIntimation respeita visibility "assigned" via responsável
      sugerido e prazo vinculado); hidratação do perfil assume a sessão salva (não a
      persona) e ressincroniza ao trocar de conta.
      Gates: `npm test` 133/133 · `npm run build` OK (31 rotas) · `npm run typecheck` OK.
      Pendente: validação de Lucas em localhost.
- [x] 5. Escritório/equipe/permissões/solicitações/saída/transferência.
- [x] 6. Perfil/configurações/assistente demo.
- [x] 7. QA geral, build e documentação da integração futura.
  - Etapa 7 (QA final / acabamento / entrega) — CONCLUÍDA:
      Removidas rotas de desenvolvimento: /dev, catch-all /[...slug] e /app/[...rest] e
      src/lib/routes.ts; adicionados 404 nativos (not-found público e in-shell). Removido
      link "Mapa técnico" da landing e CSS órfão .dev-index. Logo já correta (branca sobre
      navy no sidebar; azul sobre claro no público). Responsivo: sidebar vira drawer ≤860px,
      tabelas com .table-wrap (scroll), modais com max-height. Acessibilidade: skip link,
      focus-visible, aria-live no assistente, prefers-reduced-motion, HTML semântico.
      Isolamento coberto por testes (contas/usuário/pessoal/escritório). README do frontend
      criado (instalação, execução, testes, credenciais demonstrativas, funcionalidades,
      limitações e dependências futuras de backend); .gitignore reforçado (Node/Next/Vercel);
      Root Directory na Vercel = frontend. Sem backend, sem credenciais reais.
      Rotas (27): / · /app · /app/dashboard · /app/prazos · /app/prazos/novo ·
      /app/prazos/[id] · /app/prazos/[id]/editar · /app/calendario · /app/intimacoes ·
      /app/intimacoes/upload · /app/intimacoes/[id]/revisao · /app/notificacoes ·
      /app/escritorio · /app/escritorio/equipe · /app/perfil · /app/configuracoes ·
      /app/assistente · /login · /cadastro · /esqueci-senha · /redefinir-senha/[token] ·
      /onboarding · /onboarding/autonomo · /onboarding/escritorio · /convite/[token] ·
      /solicitar-ingresso · /_not-found.
      Gates: `npm test` 133/133 · `npm run typecheck` OK · `npm run build` OK (27 rotas).
  - Etapa 7 (correções de code review do PR) — CONCLUÍDA:
      Dashboard aplica canAccessIntimation às intimações (isolamento + permissão +
      visibilidade + responsável do prazo vinculado). Intimação em processing: campo
      createdBy permite ao autor acompanhar/remover o item pendente sem afrouxar
      isolamento. .gitignore: regras Python ancoradas a /backend e salvaguarda
      !/frontend/src/** (git check-ignore confirma que frontend/src/lib não é ignorado);
      + backups/temp/.env.example. session KNOWN_PERMISSIONS derivado de ADMIN+MEMBER.
      Migração: sanitizeStored migra versões ≤ atual preservando registros válidos
      (futura/ inválida → fallback); mesma tolerância em Org/Settings. ESLint configurado
      (eslint + eslint-config-next 15.5.25, flat config, script lint) e lint LIMPO após
      corrigir <a>→<Link> e remover imports/vars e diretivas eslint-disable obsoletas.
      checkJs global revertido (684 erros implicit-any sob strict; converter .mjs→.ts
      quebraria node --test) — mitigado por tests/contracts.test.mjs (contrato .d.mts↔.mjs).
      Busca global via helper puro buildSearchHref (trata espaços/acentos). assets/
      references: 32 capturas mantidas (sem duplicatas byte-idênticas; documentam o design).
      Gates: `npm test` 158/158 · `npm run typecheck` OK · `npm run lint` OK · `npm run build` OK (27 rotas).
Por tela: funcionalidade, loading, vazio, erro, sucesso, acessibilidade, desktop/mobile e ausência de botão morto. Rota placeholder não conta.
Cenários obrigatórios:
A. Autônomo cria, edita, conclui prazo; dados e contadores consistentes.
B. Cadastro > criar escritório > convite > membro com acesso atribuído.
C. Autônomo ingressa: pessoais permanecem privados, não aparece segundo vínculo.
D. Transferência explícita move registro+comentários+anexos e gera histórico.
E. Saída preserva pessoal e remove acesso ao escritório.
F. Upload falha > retry > revisão > confirmação > cadastro sem duplicação.
G. Convite expirado/revogado/usado; solicitação aprovada/rejeitada.
H. Troca de ambiente não vaza prazo, busca, alerta ou contexto do assistente.
I. Navegação direta, refresh, back/forward, 404 e acesso negado.
J. Teclado e viewports 375/768/1440; sem overflow indevido.
Automação: ampliar testes unitários de regras demonstrativas e adicionar testes de componentes/E2E conforme implementação. Testes atuais de política NÃO provam segurança do sistema.
Rodar npm test, npm run typecheck, npm run build por etapa. Registrar resultado e pendências.

