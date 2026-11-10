# 12 — Etapa 6.3: Prazos e calendário integrados (modo integrado)

> **Base:** `0fba765` (head do PR #15, árvore idêntica à de `22ed03c`; PR aberto, com os checks
> `frontend`, `backend` e `integration` aprovados). **Backend sem alterações:** todos os contratos
> usados já existiam (Etapa 4). Dashboard, intimações e notificações continuam **não integrados**.

## 1. Telas integradas
| Rota | Fluxo |
|---|---|
| `/app/prazos` | lista com busca, filtros (status, urgência, área, vencimento de/até), ordenação e paginação **do servidor**; total e data de referência vindos da resposta |
| `/app/prazos/novo` | cadastro manual no ambiente selecionado (pessoal ou escritório) |
| `/app/prazos/[id]` | detalhe, edição com versão, concluir/cancelar/reabrir, transferência, comentários e histórico paginados |
| `/app/prazos/[id]/editar` | mesma tela, já em edição |
| `/app/calendario` | mês inicial = data de referência do servidor; **todas** as páginas do mês |

## 2. BFF: query strings controladas
Antes da 6.3, o BFF descartava qualquer query string. Agora, só as rotas que declaram `query` na
allowlist aceitam parâmetros, cada um com validador próprio:

| Rota | Parâmetros |
|---|---|
| `GET /deadlines` | `scope` (obrigatório: personal/office), `q` (≤100), `status`, `urgency`, `area` (≤60), `responsibleId` (id), `dueFrom`/`dueTo` (YYYY-MM-DD), `sort`, `dir`, `page` (1–100000), `perPage` (1–100) |
| `GET /deadlines/:id/comments` e `/history` | `page`, `perPage` (1–100) |
| `GET /calendar` | `scope`, `year` (2000–2100), `month` (1–12) obrigatórios; `status`, `page`, `perPage` (1–500) |

- Parâmetro desconhecido, **repetido**, inválido ou obrigatório ausente → 422 no BFF, sem chamar o
  backend.
- A query é **remontada** pelo BFF (`URLSearchParams`, ordem da especificação). O destino e o
  caminho continuam fixos. Valores como `/../admin?x=1` viajam codificados dentro do parâmetro e
  não alteram a rota. `callBackend` recusa caminho com `?`, `#` ou `\`.
- Rotas das etapas anteriores, que não declaram `query`, continuam ignorando a query recebida,
  como antes.
- Allowlist ampliada só com prazos, status, transferência, comentários, histórico e calendário.
  Intimações e notificações continuam fora (404).
- Mantidos: CSRF/Origin, cookies `HttpOnly`, tokens só no servidor, limites de corpo e tempo,
  `no-store`, sem redirecionamentos, `Retry-After` e `X-Current-Version` preservados.

## 3. Autorização refletida (o backend decide)
- **Pessoal:** só o dono, inclusive perante administradores.
- **Escritório:** vínculo atual + `deadline.read` + (visibilidade `all` ou ser o responsável).
  Criar exige `create` + `read`; editar exige `edit`; concluir/cancelar/reabrir exige `complete`;
  comentar exige `create`; transferir exige `transfer` + `read`. Cargo, autoria e gestão de equipe
  não concedem nada (`deadline-caps.mjs`).
- **Responsáveis selecionáveis:** pessoal → só o dono; visibilidade `assigned` → só a própria
  pessoa (campo bloqueado); `all` → membros atuais da projeção autorizada da equipe.
- **Nomes:** vêm da projeção **pública** da equipe (`GET /offices/:id/members`), sem e-mails. Quem
  não está na projeção aparece como "Pessoa fora do escritório", nunca como identificador.
- **Revisão de autorização** (6.2) preservada: troca de usuário, ambiente, vínculo, permissões ou
  visibilidade descarta dados, formulários e seleções, e refaz as consultas. Respostas antigas não
  repovoam nada. 403/404 revalidam o vínculo, sem logout.
- **Chaves de cache:** usuário, escritório, ambiente e revisão, mais o recurso, que inclui a query
  canônica (filtros, ordenação, página), o mês, o id do prazo e a página de comentários/histórico.

## 4. Concorrência e erros
- `version` lida é enviada em `PATCH`, `status` e `transfer`.
- **409 `version_conflict`:**
  - nada é reenviado nem sobrescrito;
  - o rascunho é mantido e a tela explica o conflito;
  - "Carregar versão atual" atualiza o prazo, mantendo o rascunho;
  - salvar de novo é uma nova confirmação explícita, enviada com a versão nova.
- **Mutações nunca são repetidas automaticamente**, inclusive comentários. Em resultado
  desconhecido (timeout após envio ou erro de rede), a tela diz que a operação pode ter ocorrido,
  mantém o texto e oferece "Conferir…" antes de um novo envio.
- Tratamento separado de 401 (sessão), 403/404 (revalidação, sem logout), 409, 422, 429 e
  indisponibilidade.
- Recarregar após uma mutação mantém os dados da **mesma chave** visíveis durante a atualização.
  Uma mudança de chave ou de revisão continua descartando tudo.

## 5. Datas, urgência e calendário
- Datas de prazo são **datas civis**, formatadas por texto (`civil-date.mjs`), sem `new Date(...)`
  local, então não mudam de dia com o fuso. O E2E abre o mesmo prazo em `Pacific/Kiritimati`
  (UTC+14) e em `America/Los_Angeles` (UTC−8).
- **Urgência, data de referência e fuso** vêm do servidor (`urgency`, `referenceDate`,
  `timezone`). Não há relógio demonstrativo.
- O vencimento é informado e revisado pelo usuário. Duração e forma de contagem aparecem como
  **referência organizacional, não cálculo processual oficial**.
- **Calendário:** o mês inicial vem de uma consulta mínima (`perPage=1`) que obtém a data de
  referência do servidor. Todas as páginas do mês são buscadas em sequência (`perPage=500`, limite
  do contrato), com progresso. **Total e contagens por dia vêm do servidor** (mês inteiro
  autorizado), nunca de uma página parcial. Se um teto de segurança de páginas for atingido, a tela
  avisa que a lista do mês está incompleta.

## 6. Transferência pessoal → escritório
- Disponível só para prazo pessoal, no ambiente pessoal, com vínculo e `deadline.transfer` +
  `deadline.read`.
- A tela explica que **comentários e histórico passam a ser compartilhados** e exige consentimento
  explícito (`confirmSharing`).
- Se o backend responder 409 `linked_intimation_requires_consent`, aparece uma **confirmação
  específica** sobre a intimação vinculada. Só então `shareLinkedIntimation: true` é enviado. O
  primeiro envio nunca o inclui, e nenhuma rota de intimação foi aberta no BFF.

## 7. Comentários e histórico
Paginados no servidor. Autores e pessoas citadas aparecem por nome autorizado. O histórico é
descrito em português (`history-format.mjs`); referências protegidas (`*Hidden`) aparecem só como
vínculo existente ("a partir de uma intimação", "com a intimação vinculada"), sem identificadores.

## 8. Divergências entre documentação anterior e código (registradas)
- O estado de convite utilizado é `used` no código (documentos anteriores falavam em "aceito").
- O doc 11 dizia que query strings não eram repassadas; isso mudou na 6.3 (ver §2).
- O rodapé da moldura de autenticação mostrava "Ambiente demonstrativo · sem autenticação real"
  também no modo integrado. Corrigido: no integrado mostra "Ambiente de desenvolvimento/teste · não
  use dados reais de clientes".

## 9. Testes
| Tipo | Arquivo |
|---|---|
| Unitários (dublês) | `frontend/tests/deadlines-integration.test.mjs`: allowlist e query, proxy (destino fixo, codificação, 422 sem backend), `X-Current-Version`/`Retry-After`, cliente (query canônica, consentimentos), calendário completo, datas em vários fusos, capacidades, nomes, histórico |
| Integração real | `frontend/tests/integration/deadlines-backend.test.mjs`: privacidade pessoal, assigned × all, filtros/ordenação/paginação, conflito de versão, transições e responsável inativo, transferência com intimação vinculada, calendário com 3 páginas, comentários/histórico, perda de `deadline.read` |
| E2E | `frontend/e2e/deadlines.spec.ts`: cadastro/edição/status/comentário e fusos distintos, lista no servidor, assigned × all e isolamento, conflito em duas abas, comentário com resultado desconhecido, calendário com 505 prazos (2 páginas), perda de permissão com resposta pausada, responsável inativo, transferência e consentimentos |

As fixtures de massa (prazos semeados, prazo com intimação vinculada) usam a **API existente do
backend**, com contas de teste. Nenhuma rota de módulo futuro foi aberta no BFF.

## 10. Limitações
- Tudo em memória (BFF e backend); um processo; não publicar.
- Dashboard não integrado (sem indicadores inventados).
- Calendário com teto de segurança de 50 páginas × 500 itens por mês (25 mil prazos); acima disso,
  aviso de lista incompleta, com total e contagens por dia continuando corretos.
