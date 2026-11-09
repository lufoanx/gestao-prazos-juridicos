# 08 — Etapa 4: Prazos, calendário, comentários, histórico, transferência e responsabilidades

> **Estado:** implementado no backend com armazenamento **em memória** e integração **real em
> memória** entre escritórios e prazos (remoção/saída de membros com reatribuição). **Não** há
> banco de dados (PostgreSQL/ORM/migrations) nem integração com as telas: o frontend continua
> demonstrativo. Intimações, arquivos, notificações, e-mail e IA continuam fora do backend.

## 1. Escopo
| Item | Estado |
|---|---|
| Criar, listar, consultar e editar prazos | implementado |
| Concluir, cancelar e reabrir (com reatribuição) | implementado |
| Comentários (criar, listar) | implementado — sem edição/exclusão |
| Histórico (somente leitura) | implementado |
| Filtros, busca, paginação e calendário paginado | implementado |
| Transferência pessoal → escritório | implementado |
| Reatribuição de prazos em aberto na remoção/saída | implementado (porta real `DeadlineResponsibilityPort`) |
| Exclusão definitiva de prazos | fora do escopo (usa-se cancelamento) |
| Transferência escritório → pessoal ou entre escritórios | fora do escopo |
| Persistência em banco / integração com telas | planejado |

## 2. Modelo e validação
Campos: `scope` (pessoal `{ownerId}` ou escritório `{officeId}`), `title` (3–200), `caseNumber`
(3–50, **sem** formato CNJ), `court` (2–120), `practiceArea` (texto livre 1–60, independente das
áreas do responsável), `responsibleId`, `status` (`open|completed|cancelled`), `priority`
(`normal|high`), `startDate` e `dueDate` (datas civis `YYYY-MM-DD` reais entre 2000-01-01 e
2100-12-31; `dueDate ≥ startDate`), `countingMode` (`business|calendar`), `duration` (inteiro
1–3650), `reviewed` (padrão `true` no cadastro manual, editável), `agendaTime` (`HH:MM`,
opcional). Controlados pelo servidor: `id`, `createdBy`, `createdAt`, `updatedAt`, `version`,
histórico.

- **Datas civis × instantes:** datas do prazo nunca passam por conversão de fuso; instantes de
  eventos são UTC, do relógio injetável.
- **Vencimento:** informado pelo usuário. `duration` e `countingMode` são referências
  organizacionais; o servidor **não** recalcula nem sobrescreve o vencimento e **não** exige
  igualdade com a diferença entre as datas. Não é cálculo processual oficial. O cálculo legado
  (`/calcular-prazo`) continua demonstrativo e inalterado.
- **`reviewed`:** declaração do usuário de que conferiu os dados — não é certificação jurídica
  nem validação automática.
- Campos extras → 422. `PATCH` não altera identidade, dono, escopo, status, autoria, datas de
  evento nem histórico.

## 3. Matriz de autorização
Leitura (detalhe, listagem, calendário, comentários, histórico e totais):
- **pessoal:** só o proprietário (administradores de escritório não acessam);
- **escritório:** vínculo atual + `deadline.read` + (`visibility=all` ou ser o responsável).

| Operação | Pessoal (dono) | Escritório |
|---|---|---|
| Criar | ✔ (responsável = dono) | `deadline.create` + `deadline.read`; `assigned` só para si; `all` para qualquer membro ativo |
| Editar (`PATCH`) | ✔ | leitura + `deadline.edit` |
| Trocar responsável no `PATCH` | — (sempre o dono) | leitura + `deadline.edit`; `assigned` não atribui a outra pessoa; destino membro ativo |
| Concluir / cancelar / reabrir | ✔ | leitura + `deadline.complete` |
| Reabrir com novo responsável | ✔ (dono) | leitura + `deadline.complete` + `deadline.edit` + regra de visibilidade |
| Comentar | ✔ | leitura + `deadline.create` |
| Ver comentários / histórico | ✔ | leitura |
| Transferir pessoal → escritório | dono + vínculo atual no destino + `deadline.transfer` + `deadline.read` + `confirmSharing=true` | — |
| Reatribuição na remoção/saída | — | autorização administrativa da remoção/saída (Etapa 3); **não** exige `deadline.edit` |

`office.manage`, `team.manage`, cargo e `createdBy` não concedem acesso a prazos. Sem leitura
→ 404 (mesmo corpo de inexistente); com leitura e sem permissão → 403. A autorização é
verificada **antes** da versão: `version_conflict` e `X-Current-Version` nunca são revelados a
quem não pode operar o prazo.

## 4. Status
Transições: `open → completed`, `open → cancelled`, `completed → open`, `cancelled → open`.
`completed ↔ cancelled` direto → 409 `invalid_transition`. Status já atual → 409
`status_unchanged` (sem versão nem histórico). Reabrir prazo de escritório cujo responsável não é
mais membro → 409 `responsible_inactive`, salvo se o pedido trouxer `responsibleId` de membro
ativo (exige também `deadline.edit`). Concluídos/cancelados de quem saiu **não** são alterados.

## 5. Concorrência: versão otimista
`version` (inteiro, começa em 1) é obrigatório em `PATCH`, `status` e `transfer`; diferente do
atual → 409 `version_conflict` + cabeçalho `X-Current-Version`. Comparação, alteração e
histórico ocorrem na mesma transação. Toda mudança efetiva incrementa a versão — inclusive a
reatribuição administrativa. `PATCH` sem mudança efetiva devolve o prazo sem nova versão nem
evento. Comentários não usam versão, mas revalidam a autorização na operação.

## 6. Transações entre escritórios e prazos
- **Escritas preparadas (copy-on-write)** em `app/repositories/memory_tx.py`: cada transação
  trabalha numa cópia preguiçosa do estado; os valores são imutáveis (dataclasses congeladas,
  `frozenset`, `tuple`); o estado confirmado não muda durante a transação.
- **Unidade de trabalho** (`app/repositories/unit_of_work.py`): `unit(clock)` adquire os locks na
  **ordem única escritórios → prazos**, lê o relógio **depois** dos locks e expõe `tx.org`,
  `tx.deadlines` e `tx.now`. Toda operação de prazo (que consulta vínculos) e toda remoção/saída
  usam a unidade. `transaction(clock)` (só escritórios) não pode remover vínculos.
- **Commit:** (1) preparação final — limites de capacidade e invariante "nenhum prazo em aberto
  do escritório com responsável fora do escritório"; (2) publicação — troca das referências de
  estado (escritórios, depois prazos), com restauração das duas se algo falhar no meio.
  Qualquer exceção, em qualquer ponto, descarta tudo.
- **Remoção/saída** numa só unidade: autorização → último admin/sucessor → consulta dos prazos em
  aberto → reatribuição + histórico (preparados) → promoção do sucessor → remoção do vínculo.
- **PostgreSQL (planejado):** a mesma unidade vira uma transação de banco com
  `SELECT ... FOR UPDATE`, `UPDATE ... WHERE version = :v` e restrições únicas.
- Testado com falhas injetadas após reatribuir, após o histórico (inclusive no 2º prazo), após
  promover o sucessor, após remover o vínculo, na preparação final e no meio da publicação,
  comparando o estado integral dos dois módulos e seus índices.

## 7. Contratos (base `/api/v1`)
| Método e rota | Resposta |
|---|---|
| `GET /deadlines?scope=personal\|office&q=&status=&urgency=&area=&responsibleId=&dueFrom=&dueTo=&sort=dueDate\|title\|priority\|status\|createdAt&dir=asc\|desc&page=&perPage=` | 200 `{items, page, perPage, total, pageCount, referenceDate}` |
| `POST /deadlines` `{scope, title, caseNumber, court, practiceArea, responsibleId?, priority?, startDate, dueDate, countingMode, duration, agendaTime?, reviewed?}` | 201 prazo |
| `GET /deadlines/{id}` | 200 prazo (com `version`, `urgency`) |
| `PATCH /deadlines/{id}` `{version, ...campos editáveis}` (`agendaTime: null` remove) | 200 |
| `POST /deadlines/{id}/status` `{version, status, responsibleId?}` | 200 |
| `POST /deadlines/{id}/transfer` `{version, officeId, confirmSharing: true}` | 200 `{deadline, notice}` |
| `GET\|POST /deadlines/{id}/comments` `{text}` (1–2000) | 200 página / 201 |
| `GET /deadlines/{id}/history` | 200 página (somente leitura; 405 para escrita) |
| `GET /calendar?scope=&year=&month=&status=&page=&perPage=` | 200 `{year, month, referenceDate, timezone, items, countsByDay, page, perPage, total, pageCount, hasNextPage, nextPage}` |

Listagem: `perPage` 1–100 (padrão 20); autorização aplicada **antes** de filtrar, contar e
paginar; ordenação estável com desempate por `id`. Calendário: intervalo civil do mês; até 500
itens por página, **todos os itens recuperáveis** por paginação explícita; ordenação por
vencimento, horário e `id`; `countsByDay` conta o mês inteiro autorizado.

Urgência (`overdue|today|soon|upcoming`, só para prazos em aberto) é classificação **visual**,
calculada com a data de hoje em `DEADLINES_TIMEZONE` (padrão `America/Sao_Paulo`) e limiar
`DEADLINES_SOON_DAYS` (3). Não é regra jurídica.

Códigos de erro: `not_found` 404 · `forbidden` / `delegation_not_allowed` 403 ·
`responsible_invalid` / `invalid_dates` / `validation_error` 422 · `version_conflict` /
`status_unchanged` / `invalid_transition` / `responsible_inactive` / `not_transferable` /
`deadline_limit_reached` / `comment_limit_reached` / `history_limit_reached` /
`reassign_required` 409.

### Exemplos
```bash
H='Authorization: Bearer <accessToken>'
curl -X POST localhost:8000/api/v1/deadlines -H "$H" -H 'content-type: application/json' -d '{
  "scope":"office","title":"Contestação","caseNumber":"0001234-56.2026","court":"TJSC 2ª Vara",
  "practiceArea":"Cível","startDate":"2026-11-09","dueDate":"2026-11-20","countingMode":"business",
  "duration":10,"agendaTime":"14:00"}'
curl "localhost:8000/api/v1/deadlines?scope=office&urgency=soon&page=1&perPage=20" -H "$H"
curl -X PATCH localhost:8000/api/v1/deadlines/<id> -H "$H" -H 'content-type: application/json' \
  -d '{"version":1,"dueDate":"2026-11-25"}'
curl -X POST localhost:8000/api/v1/deadlines/<id>/status -H "$H" -H 'content-type: application/json' \
  -d '{"version":2,"status":"completed"}'
curl -X POST localhost:8000/api/v1/deadlines/<id>/transfer -H "$H" -H 'content-type: application/json' \
  -d '{"version":1,"officeId":"<officeId>","confirmSharing":true}'
curl "localhost:8000/api/v1/calendar?scope=office&year=2026&month=11&perPage=500&page=1" -H "$H"
```

## 8. Transferência pessoal → escritório
Mesmo `id`, comentários, histórico e autoria; sem duplicação. O responsável continua sendo o
dono (agora membro ativo do escritório). Permitida em qualquer status. **A partir da
transferência, comentários e histórico passam a ser visíveis a quem tiver acesso ao prazo no
escritório** — por isso `confirmSharing: true` é obrigatório e a resposta traz `notice`.
Intimações e arquivos não existem no backend e serão integrados em suas etapas.

## 9. Remoção e saída (integração real)
A porta padrão agora é `DeadlineResponsibilityPort`: reatribui **somente os prazos em aberto do
escritório**, com versão +1, `updatedAt` e evento `reassigned` (`fromResponsibleId`,
`toResponsibleId`, `reason: member_removed|member_left`, ator). Concluídos/cancelados e prazos
pessoais não são tocados. Havendo prazos em aberto, `reassignTo` é obrigatório (outro membro
ativo do mesmo escritório; 409 `reassign_required`). Último administrador continua exigindo
sucessor. A perda do vínculo vale na próxima requisição. `UnavailableResponsibilityPort`
continua disponível por injeção explícita (modo indisponível → 409, sem efeito).

## 10. Limites e retenção
| Variável | Padrão | Política |
|---|---|---|
| `DEADLINES_MAX_PER_SCOPE` | 10.000 | prazos por ambiente (pessoal de um usuário / escritório) |
| `DEADLINES_MAX_COMMENTS` | 1.000 | comentários por prazo |
| `DEADLINES_MAX_HISTORY` | 2.000 | eventos de histórico por prazo |
| `DEADLINES_TIMEZONE` | America/Sao_Paulo | fuso da data de referência (nome IANA validado) |
| `DEADLINES_SOON_DAYS` | 3 | limiar visual de "próximo" |

Ao atingir um teto, a operação é **recusada** (409) — nada é truncado nem apagado. Os limites
são validados na preparação final, antes de confirmar qualquer parte (inclusive numa remoção
que reatribui vários prazos). Prazos não expiram (não há exclusão nesta etapa). Paginação:
listagem até 100 e calendário até 500 por página; comentários e histórico até 100.

**Dependência nova:** `tzdata==2026.5` — base IANA de fusos para `zoneinfo` no Windows (que não
a traz no sistema); publicada há mais de duas semanas.

## 11. Testes
`test_deadline_policies.py`, `test_deadlines_http.py`, `test_deadlines_status_transfer.py`,
`test_deadlines_comments_calendar.py`, `test_deadlines_members.py` (integração real e rollback
com falhas injetadas), `test_deadlines_concurrency.py` (ordem forçada com `UnitGate` +
barreiras) e `test_unit_of_work.py` (escritas preparadas, publicação, capacidade, invariante,
ordem de locks). Testes da Etapa 3 que esperavam o bloqueio foram adaptados: o modo indisponível
segue coberto com a porta injetada explicitamente, e os dublês da porta receberam a transação.

## 12. Limitações
- Armazenamento em memória: perda ao reiniciar, um worker, bloqueado em production.
- Histórico não é auditoria persistente.
- Toda operação de prazo usa os dois locks (simplicidade e segurança em vez de concorrência).
- Fuso de referência único por instância (não há fuso por escritório).
- Sem integração com as telas; o frontend segue com dados locais demonstrativos.
