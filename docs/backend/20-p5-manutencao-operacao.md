# 20 — P5: manutenção e operação do PostgreSQL

> **Base:** `main` `7374d922b8e6212c1fdf4e05fbae11f420ca2d4f` (merge do PR #21, P4). CI pós-merge
> `43311783302` conferido verde (integração nos dois modos, E2E em PostgreSQL e verificações de
> dados) antes de começar. Branch: `feature/persistence-p5-maintenance`.
>
> **Correção da auditoria** (commit incremental sobre `9bed4d9`): justiça entre categorias na
> execução oportunista e status parcial no comando (§4.1 e §5).
>
> **Escopo:** manutenção global de retenção no PostgreSQL. Inclui a função verificável, a execução
> oportunista limitada e o comando explícito, com testes. Modos `memory`/`postgres`, contratos HTTP
> e regras de negócio preservados. Migrations `0001`–`0003` inalteradas. Produção segue bloqueada.

## 1. Mapa dos componentes
```
backend/app/maintenance/
├─ purge.py          # regras de retenção, lotes com SKIP LOCKED, resultado verificável (run_maintenance)
├─ opportunistic.py  # execução oportunista: ≤ 1 por intervalo e por processo, depois da resposta
└─ __main__.py       # comando: python -m app.maintenance purge (códigos de saída documentados)
backend/app/main.py                       # liga a execução oportunista em STORAGE=postgres (middleware)
backend/app/repositories/sql/sessions.py  # purge_expired → mesma rotina limitada (antes: laço global)
backend/app/repositories/sql/resets.py    # purge_expired → mesma rotina limitada (antes: DELETE global)
backend/app/repositories/sql/domain/unit.py  # SqlUnitOfWork.purge(now) → rotina do domínio (antes: 0)
backend/tests/test_maintenance_postgres.py   # retenção, fronteiras, bloqueios, falhas, limites, concorrência
backend/tests/test_maintenance_operation.py  # oportunista, comando real, startup, equivalentes dos memory_only
```
**Organização dos expurgos existentes da P3:** os dois `purge_expired` SQL da autenticação tinham
caminhos globais sem limite (laço até esvaziar; `DELETE` único). Agora delegam à mesma rotina
(`run_maintenance`, uma categoria, lotes limitados). O comportamento público é o mesmo (remover as
expiradas e devolver quantas saíram). A limpeza **por usuário** feita ao pedir recuperação
(`issue_replacing_active`) continua: aplica a mesma política só aos tokens do próprio usuário,
dentro da operação aprovada na P3.

## 2. Dado → retenção → exclusão → teste
Fronteira **inclusiva**, igual à da memória: o registro sai quando `agora − referência ≥ retenção`.

| Dado | Retenção (referência) | Exclusão | Teste (PostgreSQL real) |
|---|---|---|---|
| Sessão | expirada (`expires_at ≤ agora`) | hashes usados → sessão | `test_sessoes_expiradas_saem_com_hashes_e_revogada_valida_fica` |
| Sessão revogada ainda válida | **mantida** (detecção de reutilização) | — (o limite de sessões da P3 continua igual) | idem |
| Token de recuperação | usado, invalidado ou expirado | token | `test_tokens_de_recuperacao_usados_invalidados_ou_expirados` |
| Convite | encerrado: `closed_at`; pendente expirado: `expires_at`; + `ORG_CLOSED_RETENTION_SECONDS` | convite | `test_convites_por_encerramento_ou_expiracao_na_fronteira` (inclui "aceito há 9 dias, expirado há 50" → fica) |
| Solicitação | decidida: `decided_at` + retenção | solicitação | `test_solicitacoes_decididas_apos_retencao` |
| Intimação | **só descartada**: `closed_at` + `INTIMATIONS_DISCARD_RETENTION_SECONDS` | notificações e eventos → intimação | `test_intimacao_descartada_sai_com_eventos_e_notificacoes` |
| Notificação | lida: `read_at` + `NOTIFICATIONS_READ_RETENTION_SECONDS` | notificação | `test_notificacoes_lidas_apos_retencao_e_nao_lidas_ficam` |
| Contas, escritórios, vínculos, prazos, comentários, históricos de prazos | **nunca por idade** | — | `test_dados_permanentes_nunca_expurgados_por_idade` |

Cada teste confere o registro 1 µs antes (fica) e no instante exato (sai). O limite da caixa por
destinatário continua sendo o da P4.

## 3. Transações, bloqueios e falhas
- **Um lote = uma transação curta e própria**, nunca dentro de uma operação de negócio, com
  `SET LOCAL lock_timeout` e `statement_timeout` próprios (`MAINTENANCE_*_MS`).
- **Seleção:** `ORDER BY id` com `LIMIT` e `FOR UPDATE SKIP LOCKED`.
- **Relógio:** o instante é capturado **depois** dos bloqueios, e o `DELETE` revalida o predicado
  com ele.
- **Pai e filhos:** os filhos também são travados com `SKIP LOCKED`. Se algum filho estiver
  bloqueado, o conjunto inteiro fica para uma execução futura: o pai **não** é apagado por cascata.
  Os filhos são apagados explicitamente antes do pai.
- **Linhas puladas** (bloqueadas) não são reselecionadas na mesma execução, então não há laço
  infinito.
- **`SKIP LOCKED` não elimina todas as esperas** (ex.: `LOCK TABLE`). Para elas existe o
  `lock_timeout` curto.
- **Falha:** timeout, deadlock ou erro faz `ROLLBACK` do lote atual e **encerra a execução**. Lotes
  já confirmados permanecem e entram na contagem. Não há repetição automática; nova tentativa só
  numa execução futura.
- **Conexões:** cada lote usa `with engine.connect()` e é devolvido ao pool em qualquer caminho
  (testado depois de execuções normais e com falha).

## 4. Execução oportunista
- Só em `STORAGE=postgres` (a memória mantém sua limpeza própria).
- **No máximo uma por intervalo e por processo:** reivindicação sob lock não bloqueante. A
  reivindicação conta como execução mesmo se falhar, e uma execução em curso bloqueia outra mesmo
  com o intervalo vencido.
- Roda como tarefa de segundo plano **depois** da resposta. A conexão e a transação de negócio já
  terminaram, e a manutenção usa conexões próprias.
- **Trabalho limitado:** `MAINTENANCE_OPPORTUNISTIC_MAX_BATCHES` × `MAINTENANCE_BATCH_SIZE`.
- **Uma falha nunca propaga:** a resposta e o resultado confirmado não mudam (testado).
- Sem agendador permanente.

### 4.1 Progresso entre categorias (correção da auditoria)
**Defeito:** as categorias eram sempre percorridas na mesma ordem, e cada sondagem vazia gastava
um lote do orçamento. Com `MAINTENANCE_OPPORTUNISTIC_MAX_BATCHES=4`, as quatro primeiras categorias
esgotavam o orçamento, e tokens e sessões nunca eram visitados. Um acúmulo contínuo na primeira
categoria também consumia todo o orçamento.

**Estratégia atual** (`run_maintenance` e `OpportunisticMaintenance`):
1. **Orçamento só para trabalho:** só lotes com ≥ 1 linha selecionada contam em `max_batches`.
   Uma categoria vazia custa uma sondagem, no máximo uma por categoria e por execução, e sai da
   execução. Transações por execução ≤ `max_batches` + 6.
2. **Rodízio dentro da execução:** cada passada dá no máximo um lote a cada categoria ainda
   ativa. Um acúmulo contínuo numa categoria divide o orçamento com as outras.
3. **Cursor entre execuções** (por processo):
   - a próxima execução começa pela categoria que ficou sem vez quando o orçamento acabou;
   - depois de uma falha, começa pela categoria seguinte à que falhou, sem laço sobre ela; a que
     falhou volta a ser tentada nas passadas seguintes, no máximo uma vez por execução;
   - depois de uma execução completa, avança uma posição.

   Com orçamento 1, as seis categorias são atendidas em ciclo.
4. **Após reinício,** o cursor recomeça num deslocamento derivado do relógio
   (`⌊agora/intervalo⌋ mod 6`), e não sempre na primeira categoria.
   - *Limite:* com orçamento menor que o número de categorias com acúmulo **e** reinícios a cada
     execução, a ordem depende do relógio, sem garantia estrita de rodízio entre processos.
   - O comando explícito, com orçamento suficiente, cobre esse caso.

Preservados:
- limite de trabalho por execução e no máximo uma execução por intervalo e por processo;
- transações curtas, rollback do lote, fim da execução em falha e nenhum retry;
- contagem só do que foi confirmado e os hashes das sessões revogadas ainda válidas.

| Regressão (PostgreSQL real, sequência real de execuções oportunistas) | Teste |
|---|---|
| Quatro categorias iniciais vazias; tokens e sessões expirados alcançados e limpos | `test_quatro_iniciais_vazias_tokens_e_sessoes_sao_alcancados` |
| Orçamentos 1 e 4: todas as categorias atendidas em número finito de execuções | `test_todas_as_categorias_atendidas_em_numero_finito_de_execucoes` |
| Acúmulo contínuo na primeira categoria não impede as demais | `test_acumulo_continuo_na_primeira_categoria_nao_impede_as_demais` |
| Falha persistente numa categoria: rollback, contagens corretas, sem laço, progresso retomado | `test_falha_persistente_numa_categoria_nao_trava_as_demais_nem_entra_em_laco` |
| Requisições concorrentes: execução única por intervalo | `test_requisicoes_concorrentes_preservam_intervalo_e_execucao_unica` |

## 5. Comandos seguros (só em bancos descartáveis nesta entrega)
```bash
cd backend
export DATABASE_URL=postgresql+psycopg://prazoai:<senha>@localhost:5432/prazoai_dev   # destino EXPLÍCITO
STORAGE=postgres ENVIRONMENT=development python -m app.maintenance purge --batch-size 200 --max-batches 50
```
Antes de apagar, o comando valida:
- produção recusada;
- `STORAGE=postgres`;
- só a `DATABASE_URL` informada;
- revisão `0003`, verificada somente leitura (migrations nunca rodam).

Ele não importa a aplicação web, sempre fecha o engine e escreve um JSON com as contagens
confirmadas.

| Código | Significado |
|---|---|
| 0 | concluído: todas as categorias visitadas e esgotadas (`complete: true`; linhas bloqueadas ficam em `skippedLocked`) |
| 6 | **parcial**: o limite de trabalho acabou antes (`status: "partial"`, `complete: false`, `limitReached: true`); restam pendências para outra execução |
| 1 | interrompido por falha (`failure`: `lock_timeout`, `deadlock`, `statement_timeout`, `database_error`, `error`); lotes anteriores confirmados |
| 2 | configuração inválida (inclui `ENVIRONMENT=production` e `DATABASE_URL` ausente ou inválida) |
| 3 | `STORAGE=memory`: nada feito (o estado em memória pertence a cada processo) |
| 4 | esquema ausente ou em revisão diferente da exigida (nada apagado) |
| 5 | banco indisponível ao verificar o esquema (nada apagado) |

## 6. Configuração e limites
| Variável | Padrão | Faixa |
|---|---|---|
| `MAINTENANCE_BATCH_SIZE` | 200 | 1–1000 |
| `MAINTENANCE_MAX_BATCHES_PER_RUN` (comando) | 50 | 1–10000 |
| `MAINTENANCE_LOCK_TIMEOUT_MS` | 200 | 10–5000 |
| `MAINTENANCE_STATEMENT_TIMEOUT_MS` | 5000 | 100–60000 |
| `MAINTENANCE_OPPORTUNISTIC_ENABLED` | true | — |
| `MAINTENANCE_INTERVAL_SECONDS` | 300 | 10–86400 |
| `MAINTENANCE_OPPORTUNISTIC_MAX_BATCHES` | 4 | 1–100 |

As retenções continuam em `ORG_CLOSED_RETENTION_SECONDS`, `INTIMATIONS_DISCARD_RETENTION_SECONDS`
e `NOTIFICATIONS_READ_RETENTION_SECONDS`.

## 7. Resultados parciais
`batches` conta só lotes **com trabalho** confirmados; `emptyChecks`, as sondagens sem linhas;
`visited`, as categorias atendidas; `complete`, se tudo foi esgotado nesta execução.
`removed` traz só o que foi **confirmado**, por categoria, incluindo os filhos:
`used_refresh_hashes`, `intimation_events`, `intimation_notifications`.
- **`skippedLocked`:** conjuntos pulados por bloqueio, removidos em execução futura.
- **`limitReached`:** o trabalho parou pelo limite; pode haver mais.
- **`interrupted` + `failure` + `failedCategory`:** o lote daquela categoria foi desfeito e as
  categorias seguintes não rodaram.

Os logs registram operação, duração, contagens e categoria da falha, nunca valores, tokens, URLs
ou conteúdo jurídico.

## 8. Limites restantes para produção
- Produção continua bloqueada incondicionalmente: falta a entrega de prontidão (TLS, segredos
  gerenciados, backup/restauração, observabilidade, migração supervisionada, sessões do BFF e rate
  limiting compartilhados).
- A execução oportunista é **por processo**: com vários processos, cada um pode rodar uma por
  intervalo. É seguro graças ao `SKIP LOCKED`, mas não é um agendador central (fora do escopo).
- Retenção de dados jurídicos por prazo legal não foi definida (prazos e históricos nunca são
  expurgados).

## 9. Roteiro de apresentação (TCC, cerca de 5 minutos)
1. **Problema (30 s):** "Dados temporários (sessões vencidas, convites encerrados, notificações
   lidas) cresceriam para sempre. A P5 limpa só o que a política manda, nunca prazos nem históricos."
2. **Tabela de retenção (1 min):** a mesma regra da memória, com fronteira inclusiva testada no
   instante exato.
3. **Como apaga sem atrapalhar (1 min 15 s):** lotes pequenos, `SKIP LOCKED` (quem está em uso fica
   para depois), relógio depois do bloqueio, filhos antes do pai, e nada de cascata para contornar
   filho bloqueado.
4. **Falhas honestas (1 min):** um `LOCK TABLE` provoca timeout; o lote volta, o que já foi
   confirmado é informado, a execução para e o comando sai com código 1.
5. **Quando roda (45 s):** sozinho, depois da resposta, uma vez por intervalo e por processo; ou
   pelo comando explícito.
6. **Limites (30 s):** sem agendador central e produção ainda bloqueada.
