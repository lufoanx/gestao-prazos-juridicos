# 14 — Etapa 6.4: Intimações, revisão humana e notificações integradas

> **Base:** `11a195a57e5e2c47144d3198aac41a608499f192` (head do PR #16, com a correção do E2E;
> árvore idêntica à de `df6a1b6`). A `main` ainda não continha a entrega, então a branch
> `feature/frontend-intimations-notifications` saiu desse head. **Backend sem alterações:** só
> contratos existentes (Etapa 5). Sem PDF, armazenamento, OCR/IA, e-mail ou alertas de vencimento.
> O dashboard continua fora.

## 1. O que foi integrado
| Rota | Fluxo |
|---|---|
| `/app/intimacoes` | lista com busca, status e paginação do servidor (descartadas só com o filtro "Descartadas") |
| `/app/intimacoes/upload` | registro de **metadados declarados** (nome, tamanho, tipo, data de recebimento, responsável sugerido opcional) |
| `/app/intimacoes/[id]` (e `/revisao`) | metadados, rascunho, revisão humana e confirmação, descarte, histórico |
| `/app/notificacoes` | caixa individual: paginação, filtro de não lidas, marcar uma, marcar todas do ambiente, política de retenção |
| Menu "Notificações (N)" | contador de não lidas do servidor, isolado por usuário, escritório, ambiente e revisão |

## 2. Mapa das pastas (frontend)
```
frontend/src/
├─ app/app/intimacoes/…, app/app/notificacoes/   # rotas do Next: escolhem demo × integrado (APP_MODE)
├─ integrated/                                    # telas do modo integrado (React)
│  ├─ IntegratedIntimationList.tsx                #   lista
│  ├─ IntegratedIntimationRegister.tsx            #   registro de metadados
│  ├─ IntegratedIntimationDetail.tsx              #   detalhe: rascunho, confirmação, descarte, histórico
│  ├─ IntegratedNotifications.tsx                 #   caixa + contador do menu (UnreadCount)
│  ├─ intimationShared.tsx                        #   contexto (clientes), avisos e rótulos comuns
│  ├─ deadlineShared.tsx                          #   contexto de ambiente/nomes + aviso "outro ambiente" (comum a prazos e intimações)
│  └─ DeadlineFields.tsx, useResource.ts, ui.tsx  #   reaproveitados da 6.2/6.3
├─ lib/integration/                               # lógica pura, testável sem React
│  ├─ intimations-client.mjs                      #   chamadas tipadas de intimações e notificações
│  ├─ intimation-caps.mjs                         #   capacidades de intimação + diferença do rascunho (null × omissão)
│  ├─ history-format.mjs                          #   histórico legível (prazos e intimações)
│  └─ query-cache.mjs                             #   cache por chave + reaproveitamento de leituras em andamento
└─ server/bff/allowlist.mjs                       # BFF: rotas e parâmetros permitidos
```
Responsabilidades:
- **Telas** decidem só o que exibir.
- **`lib/integration`** monta chamadas e regras de exibição.
- **BFF** autentica a sessão, valida rota e parâmetros e repassa ao backend.
- **Backend** é a única autoridade de permissão, estado e dados.

## 3. Caminho de uma requisição (ex.: confirmar uma intimação)
1. `ConfirmSection` → `intimations.confirm(id, version, dados)` (`intimations-client.mjs`).
2. `api-client.mjs` envia `POST /bff/api/intimations/:id/confirm`, com `x-prazoai-csrf` e cookie
   `HttpOnly` (o token nunca está no navegador).
3. BFF (`manager.mjs`):
   - confere Origin e CSRF;
   - casa a rota na allowlist (`:id` validado) e valida a query;
   - resolve a sessão e renova o access token se preciso;
   - reconstrói os cabeçalhos e repassa ao FastAPI com `Authorization: Bearer`, limites de corpo e
     tempo e `no-store`.
4. FastAPI: política de intimações, versão, estado, regras de criação de prazo (Etapa 4) e unidade
   de trabalho → 201/200/409/422.
5. A resposta volta pelo BFF sem cookies do backend; a tela atualiza os recursos afetados.

## 4. Fluxo "confirmar intimação → criar prazo"
1. **Registro:** só metadados (`file.storage = "not_stored"`, `processing.status = "not_available"`).
   A tela explica que o arquivo não foi enviado nem armazenado e que não há OCR/IA. Escolher um
   arquivo local apenas preenche nome e tamanho com o que o navegador informa; o conteúdo não é
   lido nem enviado.
2. **Rascunho (opcional):** `PATCH` com a versão lida. Campo inalterado é **omitido** (mantido) e
   campo apagado vai como **`null`** (limpo) (`draftChanges`). O responsável sugerido segue a mesma
   regra. Em `operational_responsible_required`, o rascunho fica na tela.
3. **Revisão humana:** formulário completo (campos da 6.3, `DeadlineFields`), pré-preenchido com o
   rascunho para conferência, mais a declaração obrigatória "Revisei manualmente…" e um diálogo de
   confirmação.
4. **Confirmação:** envia **todos** os campos finais e a versão. O servidor não completa nada (sem
   os campos, 422).
   - **201** `created=true`: "prazo criado" + link;
   - **200** `created=false`: "já havia sido confirmada; nenhum prazo novo";
   - **409** `already_reviewed`: mensagem sem identificador;
   - **409** `version_conflict`: dados mantidos e "Carregar versão atual" (reenvio só por novo
     clique);
   - **409** `invalid_state`: recarrega o estado terminal;
   - **resultado desconhecido:** "pode ter ocorrido" + "Conferir situação" (nunca reenvia).

   A mensagem de resultado fica no detalhe e sobrevive à recarga.
5. **Depois:** a intimação fica `reviewed` e só leitura. Quem pode ler o prazo vê o link. Se
   `linked=true` e `deadlineId=null`, a tela diz que existe um vínculo sem permissão de leitura: sem
   link inventado e sem buscar o id em históricos.

## 5. Fluxo "atribuição → notificação"
1. **Geração (backend):** o backend gera a notificação individual para o destinatário quando:
   - um prazo do escritório é criado ou reatribuído para alguém (`deadline_assigned`);
   - uma intimação recebe responsável sugerido, inclusive na reatribuição por saída ou remoção de
     membro (`intimation_assigned`).

   Não há notificações pessoais nem lembretes de vencimento.
2. **Leitura (sempre com a autorização atual):** listagem, contagem, `read` e `read-all` usam o
   `scope` do ambiente selecionado. Notificações de recursos que a pessoa não pode mais ler ficam
   **ocultas** e reaparecem quando o acesso volta.
3. **Na interface:**
   - o menu mostra "Notificações (N)" com a contagem do servidor (nunca derivada de uma página);
   - o contador atualiza no foco da janela, após ações relevantes (marcar como lida, salvar rascunho,
     confirmar) e por "Atualizar"; sem polling;
   - leituras simultâneas da mesma chave compartilham a requisição (`cache.dedupe`);
   - "Marcar todas como lidas" chama `POST /notifications/read-all?scope=<ambiente>`, que marca todas
     do ambiente no servidor, inclusive as que não estão na página exibida;
   - "Abrir" leva ao recurso, e o detalhe confere o ambiente real antes de mostrar qualquer dado.

## 6. Autorização, ambiente e referências protegidas
- **Capacidades de intimação** (`intimation-caps.mjs`), específicas e não copiadas das de prazos:
  - editar rascunho e confirmar = leitura + `deadline.create`, só `awaiting_review`;
  - descartar = isso + ser autor ou ter visibilidade `all`, só pendentes;
  - `retry` nunca é oferecido (sem processamento real) e a rota **não** está na allowlist;
  - cargo e gestão de equipe não concedem nada.

  A leitura é decidida pelo servidor:
  - pessoal → só o dono;
  - pendente → autor, sugerido ou `all`;
  - revisada → o responsável **atual** do prazo vinculado (a sugestão antiga não concede leitura).
- **Ambiente real:** o detalhe só renderiza se `scope` da intimação coincidir com o ambiente
  selecionado (`scopeMatches`, o mesmo dos prazos). Senão aparece "Intimação de outro ambiente", sem
  dados, com troca explícita, e a resposta não vai para o cache.
- **Revisão de autorização** (6.2) preservada: troca de usuário, ambiente, vínculo, permissões ou
  visibilidade remonta o conteúdo e o contador, e respostas antigas não repovoam nada (testado com
  respostas pausadas da lista e do contador).
- **Históricos:** legíveis (`describeIntimationEvent`), sem JSON bruto. Chaves `*Hidden` viram
  "vínculo sem permissão de leitura".

## 7. BFF
Rotas novas (somente as usadas pelas telas):

| Método e rota | Query permitida |
|---|---|
| `GET /intimations` | `scope` (obrigatório), `status`, `q`, `page`, `perPage` |
| `POST /intimations` | — |
| `GET`/`PATCH /intimations/:id` | — |
| `POST /intimations/:id/confirm`, `/discard` | — |
| `GET /intimations/:id/history` | `page`, `perPage` |
| `GET /notifications` | `scope` (obrigatório), `unreadOnly` (`true`/`false`), `page`, `perPage` |
| `GET /notifications/unread-count` | `scope` (obrigatório) |
| `POST /notifications/:id/read` | — |
| `POST /notifications/read-all` | `scope` (obrigatório) |

A validação é por **método e rota**. Parâmetro desconhecido, repetido ou inválido → 422 sem chamar
o backend. Fora: `retry`, anexos, qualquer rota de IA. Sessão, CSRF, Origin, limites, `no-store` e
tokens só no servidor continuam como antes.

## 8. Decisões
- **Detalhe em `/app/intimacoes/[id]`:** a rota demo `/revisao` mostra a mesma tela no modo
  integrado; no modo demo, `[id]` redireciona para `/revisao`.
- **Confirmação pré-preenchida com o rascunho:** a pessoa revisa e marca a declaração; o envio
  carrega todos os campos explicitamente.
- **Aviso de outro ambiente:** virou um componente comum (`ScopeMismatchNotice`), sem duplicação
  entre prazos e intimações.
- **Mensagem de conflito genérica** ("Este registro…"), válida para prazos e intimações.
- **Deduplicação de leituras** no cache: o contador do menu e a página compartilham a mesma
  requisição em andamento.

## 9. Divergências documentais registradas
- Doc 09: a notificação lista `eventId`, mas a API não expõe esse campo (é interno). A API expõe
  `summary` (prazo: título, processo, vencimento; intimação: nome do arquivo, título, status), que o
  doc não detalha.
- Doc 11/12: as notas "intimações e notificações seguem fora" foram superadas por esta etapa.

## 10. Limitações
- Tudo em memória (BFF e backend); um processo; não publicar.
- Sem PDF, armazenamento, OCR/IA, e-mail, alertas de vencimento ou processamento: `retry` e
  sugestões automáticas não aparecem.
- Contador atualizado no foco, após ações e por botão (sem tempo real).

## 11. Testes e comandos
| Tipo | Arquivo |
|---|---|
| Unitários | `frontend/tests/intimations-integration.test.mjs`: allowlist e query por método/rota, corpo só com metadados, `null` × omissão, capacidades específicas, histórico, deduplicação |
| Integração real | `frontend/tests/integration/intimations-backend.test.mjs`: privacidade pessoal, assigned × all, responsável atual após reatribuição, vínculo sem `deadlineId`, rascunho e conflito, 201/200 sem duplicar, descarte e estados terminais, `operational_responsible_required`, notificações (contagem, marcar todas além da 1ª página e só no ambiente), ocultação e recuperação |
| E2E | `frontend/e2e/intimations.spec.ts`: 8 cenários com navegador e FastAPI reais (ver §12); a transferência com intimação vinculada continua em `deadlines.spec.ts` |

```bash
cd backend  && pip check && pytest && ruff check app tests && mypy app && python -m compileall app
cd frontend && npm ci && npm test && npm run typecheck && npm run lint && npm run build
cd frontend && NEXT_PUBLIC_PRAZOAI_MODE=integrated npx next build
cd frontend && PRAZOAI_TEST_PYTHON=../backend/.venv/bin/python npm run test:integration
cd frontend && PRAZOAI_TEST_PYTHON=../backend/.venv/bin/python npm run test:e2e   # suíte inteira, um backend
```

## 12. Roteiro de apresentação (Lucas, cerca de 5 minutos)
1. **Contexto (30 s):** "O PrazoAI ainda não lê PDFs. Nesta etapa, a intimação entra como
   metadados, e uma pessoa revisa e confirma o prazo. Nada é inventado."
2. **Registro (1 min):** em `/app/intimacoes/upload`, escolher um PDF. Mostrar que só nome e
   tamanho são preenchidos e ler o aviso "não é enviado nem armazenado; sem OCR/IA". Registrar.
3. **Rascunho (45 s):** preencher título e horário e salvar. Apagar o horário e salvar de novo.
   Explicar "campo apagado = limpar; campo intacto = manter".
4. **Revisão e confirmação (1 min):** completar o formulário, marcar "Revisei manualmente…" e
   confirmar no diálogo. Mostrar "prazo criado" e abrir o prazo (vencimento informado, não
   calculado).
5. **Permissões (1 min):** numa segunda janela, entrar com uma associada de visibilidade restrita.
   Ela só vê o que lhe foi sugerido. Reatribuir o prazo e mostrar que a leitura passa ao responsável
   atual. Mostrar "vínculo sem permissão de leitura" quando for o caso.
6. **Notificações (45 s):** mostrar "Notificações (N)", marcar uma, marcar todas (inclusive da página
   2) e trocar para o ambiente pessoal, que não tem notificações.
7. **Fechamento (15 s):** "O backend é a autoridade; o BFF guarda os tokens e valida cada rota;
   nenhuma mutação é repetida sozinha. 38 + 8 testes de navegador rodam numa única execução."
