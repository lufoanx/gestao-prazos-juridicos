# 09 — Etapa 5: Intimações, revisão humana, vínculo com prazos e notificações internas

> **Estado:** implementado no backend com armazenamento **em memória**, na mesma unidade de
> trabalho de escritórios e prazos. **Não** há armazenamento de arquivos, processamento, OCR,
> IA, e-mail, PostgreSQL nem integração com as telas.

## 1. Fronteira com etapas futuras
| Item | Nesta etapa |
|---|---|
| Arquivo PDF | **Não recebido nem armazenado.** Só metadados declarados (`fileName`, `sizeBytes`, `contentType`, `receivedAt`); `file.storage = "not_stored"` sempre |
| Processamento/extração | **Indisponível** (`processing.status = "not_available"`). Sem extração fictícia, sem sugestões sorteadas, sem rota pública de processamento |
| Estados `processing`/`failed`, nova tentativa, `suggestion.source = "processing"` | **Preparados** (`ProcessingPort`) e testados só com adaptador controlado; o adaptador padrão é `ProcessingNotAvailable` |
| Revisão humana | **Obrigatória**: o prazo só nasce da confirmação com todos os dados finais explícitos |
| Notificações | Internas, individuais, sem conteúdo armazenado; **não** são alertas de vencimento (sem lembretes agendados); nenhuma notificação pessoal nesta etapa |

Etapa de arquivos (planejada): `FileStoragePort` real, envio multipart, verificação de tipo e
tamanho reais; o processamento real entrará depois, chamando a porta **após o commit**.

## 2. Modelo
- **Intimation:** `id`, `scope`, `file {name, sizeBytes, contentType, storage}`, `receivedAt`
  (data civil), `status`, `processing {status, attempts, failureCode}`, `draft` (campos do prazo,
  todos opcionais), `suggestion` (só do processamento futuro), `suggestedResponsibleId`,
  `deadlineId`, `createdBy`, `createdAt`, `updatedAt`, `closedAt`, `version`.
- **IntimationEvent:** histórico da intimação (`registered`, `draft_updated`,
  `responsible_suggested`, `confirmed`, `discarded`, `transferred`, `responsible_reassigned`,
  `retry_requested`, `processing_completed|failed`).
- **Notification:** `id`, `recipientId`, `scope`, `kind` (`deadline_assigned`,
  `intimation_assigned`), `resourceType`, `resourceId`, `eventId`, `createdAt`, `readAt`.
  **Sem título, processo ou conteúdo.**

Estados: pendentes = `processing`, `awaiting_review`, `failed`.
- `awaiting_review → reviewed` (confirmação; **terminal**);
- pendente → `discarded` (descarte lógico; **terminal**: não pode ser editada, confirmada nem
  reprocessada);
- reservados: `processing → awaiting_review | failed` (interno), `failed → processing` (retry).

## 3. Matriz de acesso
Pessoal: somente o dono. Escritório: vínculo atual + `deadline.read` e:
| Situação | Quem lê |
|---|---|
| Pendente | `visibility=all`, autor, responsável sugerido |
| Revisada | `visibility=all`, autor, **responsável ATUAL do prazo vinculado** (Issue #5) — a sugestão antiga não concede acesso |
| Descartada | `visibility=all`, autor |

| Ação | Regra (além da leitura) |
|---|---|
| Registrar | `deadline.create` + `deadline.read`; sugestão: `assigned` só a si mesmo; membro ativo |
| Editar rascunho / sugestão | `deadline.create`; mesmas regras de sugestão; só `awaiting_review` |
| Confirmar | `deadline.create` + **regras de criação de prazo da Etapa 4** (`assigned` só para si; responsável ativo; datas) |
| Descartar / tentar de novo | `deadline.create` + ser autor ou ter `visibility=all` |
| Processamento | somente interno (`apply_processing_result`), sem rota |

Gestão de equipe, cargo e `createdBy` de prazo não concedem acesso. Sem leitura → 404 (mesmo
corpo de inexistente); com leitura sem permissão → 403; autorização **antes** da versão.
Respostas de intimação só trazem `deadlineId` se o solicitante puder ler o prazo (`linked`
indica o vínculo sem revelar o id).

## 4. Confirmação: versão × idempotência
| Situação | Resposta |
|---|---|
| Primeira confirmação válida (`version` atual, `awaiting_review`, dados completos) | **201** `{intimation, deadline, created: true}` |
| Repetição após revisada, com leitura do prazo (versão pode ser antiga; payload ignorado) | **200** `{..., created: false}`, sem novo efeito |
| Repetição: lê a intimação, mas não o prazo | **409** `already_reviewed` (sem o id) |
| Não lê a intimação | **404** (igual a inexistente) |
| Lê, sem `deadline.create` | 403 |
| Versão divergente antes da revisão | 409 `version_conflict` (+ `X-Current-Version`) |
| Descartada / não aguardando revisão | 409 `invalid_state` |

O corpo exige `version` e **todos** os dados finais (título, processo, tribunal, área, datas,
contagem, duração; responsável, prioridade e horário opcionais). O servidor **não** completa
nada a partir do rascunho. Na mesma unidade: revalida acesso e permissão → (se não revisada)
versão e estado → regras da Etapa 4 → cria prazo, evento `created` com `source.intimationId`,
marca a intimação `reviewed` com o vínculo, evento `confirmed` e notificações.

## 5. Transferência de prazo com intimação vinculada
`POST /deadlines/{id}/transfer` passa a aceitar `shareLinkedIntimation` (booleano estrito).
Com intimação vinculada, é obrigatório `shareLinkedIntimation: true` além de
`confirmSharing: true` (agora também booleano estrito — antes `1` era aceito); sem isso, 409
`linked_intimation_requires_consent`, sem alteração. Prazo e intimação mudam de ambiente na
mesma unidade, preservando IDs, autoria, vínculo e históricos (eventos `transferred` nos dois).

## 6. Saída e remoção de membros
A porta real passou a cobrir intimações. Responsabilidade operacional de uma intimação
**pendente** (inclusive `processing`/`failed`) do escritório:
- responsável sugerido = membro que sai; ou
- criada pelo membro que sai sem outro responsável sugerido ativo.

Havendo prazos em aberto ou essas intimações, `reassignTo` é obrigatório; as intimações recebem
`reassignTo` como responsável sugerido (versão +1, evento `responsible_reassigned` com
`createdBy` preservado, notificação). Sugestão ativa de outra pessoa não é substituída.
Revisadas seguem o prazo; descartadas não contam. Tudo na mesma unidade da saída/remoção.

## 7. Notificações
- Gatilhos (só para outra pessoa, nunca o autor da ação; somente escritório): prazo atribuído
  (criação, `PATCH`, reabertura, reatribuição administrativa, confirmação) e intimação
  atribuída (registro, rascunho, reatribuição administrativa).
- Deduplicação por (destinatário, evento). Operações repetidas não geram eventos → não geram
  notificações, mesmo depois de expiração ou remoção pela caixa.
- Listagem, contagem, `read` e `read-all` usam a autorização **atual**: notificações de recursos
  que o destinatário não pode mais ler ficam **ocultas** (não aparecem nem contam) e voltam se o
  acesso for recuperado. O resumo é projetado na leitura.
- Ordem: instante desc, id desc.
- **Política da caixa** (exposta em `retentionPolicy`): lidas removidas após
  `NOTIFICATIONS_READ_RETENTION_SECONDS` (90 dias); acima de `NOTIFICATIONS_MAX_PER_RECIPIENT`
  (1000), removem-se primeiro as lidas mais antigas e depois as não lidas mais antigas, sem
  bloquear a operação principal. É política da caixa, não do histórico de auditoria. Índices de
  destinatário e deduplicação são removidos junto.

## 8. Contratos (base `/api/v1`)
| Rota | Resposta |
|---|---|
| `POST /intimations` `{scope, fileName, sizeBytes, contentType: "application/pdf", receivedAt, suggestedResponsibleId?}` | 201 |
| `GET /intimations?scope=&status=&q=&page=&perPage=` | 200 `{items, page, perPage, total}` (descartadas ocultas salvo `status=discarded`) |
| `GET /intimations/{id}` · `GET /intimations/{id}/history` | 200 |
| `PATCH /intimations/{id}` `{version, campos do rascunho (null limpa), suggestedResponsibleId?}` | 200 |
| `POST /intimations/{id}/confirm` `{version, dados finais}` | 201 / 200 (ver §4) |
| `POST /intimations/{id}/discard` `{version}` · `POST /intimations/{id}/retry` `{version}` | 200 |
| `GET /notifications?scope=personal\|office&unreadOnly=&page=&perPage=` | 200 `{items, page, perPage, total, unread, retentionPolicy}` |
| `GET /notifications/unread-count?scope=` · `POST /notifications/{id}/read` · `POST /notifications/read-all?scope=` | 200 |

Erros novos: `already_reviewed`, `invalid_state`, `processing_unavailable`,
`linked_intimation_requires_consent`, `intimation_limit_reached`,
`intimation_history_limit_reached` (409). Arquivo: `.pdf`, `application/pdf`, 1 byte a 10 MB
(limite declarado do protótipo; nada é recebido).

## 9. Unidade de trabalho
Ordem de locks **escritórios → prazos → intimações → notificações**; relógio lido após todos.
Escritas preparadas nos quatro armazenamentos. Preparação final: capacidades (prazos,
intimações, eventos), política da caixa (exclusões também preparadas), responsáveis válidos de
prazos e intimações pendentes, vínculo único e recíproco, registros vinculados existentes e
mesmo ambiente. Publicação: troca das quatro referências com restauração integral. As regras de
criação/reatribuição/histórico/notificação estão em `app/services/deadline_ops.py` (operações
sobre transação aberta), usadas por prazos, intimações e pela porta — sem transação aninhada.
Unicidade do vínculo também é garantida no próprio armazenamento (equivalente a `UNIQUE`).

## 10. Limites e retenção
| Variável | Padrão |
|---|---|
| `INTIMATIONS_MAX_PER_SCOPE` | 5.000 |
| `INTIMATIONS_MAX_EVENTS` | 500 por intimação |
| `INTIMATIONS_DISCARD_RETENTION_SECONDS` | 30 dias (descartadas removidas com eventos e índices) |
| `NOTIFICATIONS_MAX_PER_RECIPIENT` | 1.000 |
| `NOTIFICATIONS_READ_RETENTION_SECONDS` | 90 dias |

## 11. Testes
`test_intimation_policies.py`, `test_intimations_http.py`, `test_intimations_confirm.py`
(versão, dados explícitos, idempotência, confirmações concorrentes, PATCH × confirmação, falhas
em cada fase da publicação, transferência com vínculo), `test_intimations_members.py`
(saída/remoção com intimações, falhas entre prazos e intimações), `test_notifications.py`,
`test_intimations_processing_retention.py` (adaptador controlado, retenção, capacidade,
invariantes, rollback da caixa) e `test_intimations_concurrency.py`.

## 12. Limitações
- Sem arquivo, processamento, OCR ou IA; sem notificações pessoais nem lembretes de vencimento.
- Armazenamento em memória (perda ao reiniciar, um worker, bloqueado em production).
- Históricos não são auditoria persistente.
- Toda operação usa os quatro locks.
