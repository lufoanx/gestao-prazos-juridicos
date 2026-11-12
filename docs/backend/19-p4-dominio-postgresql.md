# 19 — P4: domínio no PostgreSQL

> **Base:** `main` `ad53f4a7d4e5aa9740c95b001f94f5d983027844` (merge do PR #20, P3). CI pós-merge
> `43234166893` conferido verde (incluindo integração e E2E) antes de começar. Branch:
> `feature/persistence-p4-domain`.
>
> **Correções da auditoria** (commit incremental sobre `fc846b2`): ver §8 (artefatos incompletos,
> CI efetivo, MyPy, relógio realmente pós-lock, solicitação × ingresso).
>
> **Escopo:** escritórios, vínculos, permissões, convites, solicitações, prazos, comentários,
> histórico, intimações (rascunho, eventos, vínculo com prazo) e notificações (deduplicação,
> leitura, capacidade da caixa) no PostgreSQL, com SQLAlchemy Core e psycopg síncrono. A
> implementação em memória continua para testes rápidos. Contratos HTTP preservados; produção
> continua bloqueada; manutenção global (expurgo em lotes) fica para a P5.

## 1. Mapa dos arquivos
```
backend/app/
├─ domain/errors.py                    # erros COMPARTILHADOS: CapacityError, ConsistencyError,
│                                      #   DomainConflictError (409), JoinCodeCollisionError
├─ repositories/unit.py                # contrato UnitOfWork: unit / transaction / read / purge
├─ repositories/queries.py             # contrato de CONSULTAS (critérios + implementação em memória)
├─ repositories/{org,deadlines,intimations}.py   # protocolos de transação (+ queries, lock_anchors)
├─ repositories/unit_of_work.py        # MemoryUnitOfWork (mantida; read = unidade com locks globais)
├─ repositories/sql/domain/            # P4: PostgreSQL
│  ├─ unit.py                          # SqlUnitOfWork, SqlContext (âncoras, relógio pós-lock, preparação, COMMIT)
│  ├─ mapping.py                       # linha ↔ entidade; colunas derivadas das FKs diferidas
│  ├─ org.py / deadlines.py / intimations.py / notifications.py   # transações por módulo
│  └─ queries.py                       # autorização, filtros, busca, ordenação e paginação no SQL
├─ db/tables/*.py                      # + coluna interna `seq` (migration 0003)
├─ services/*_service.py               # dependem só dos contratos; leituras em `read()`
├─ services/org_container.py           # STORAGE=postgres → SqlUnitOfWork com o engine da autenticação
└─ core/errors.py                      # handlers: ConcurrentUpdateError e DomainConflictError → 409
backend/migrations/versions/0003_ordem_interna_eventos.py         # `seq` (aprovada na auditoria)
backend/tests/
├─ test_domain_sql_concurrency.py      # concorrência, rollback, consistência, páginas, persistência (27)
├─ test_domain_sql_equivalents.py      # equivalentes SQL dos testes memory_only (5)
├─ test_db_p4_seq.py                   # migration 0003 com dados, downgrade/upgrade, lacunas (4)
├─ sql_store_views.py                  # visões SOMENTE LEITURA do banco com a interface dos armazenamentos
└─ conftest.py                         # PRAZOAI_TEST_STORAGE=postgres roda as MESMAS suítes HTTP no banco
```

## 2. Caminho de uma requisição (`POST /deadlines/{id}/transfer`)
1. `DeadlineService.transfer` abre `uow.unit(clock)` (uma conexão, uma transação).
2. `tx.lock_anchors(office_ids=(destino,), user_ids=(ator,))` trava as âncoras na ordem aprovada:
   escritório, depois usuário, com `FOR NO KEY UPDATE`.
3. Leituras **depois** das âncoras:
   - vínculo do ator (identificação preliminar → âncora → releitura);
   - prazo (`FOR UPDATE`, escopo revalidado);
   - intimação vinculada (`FOR UPDATE`).
4. Regras do serviço, inalteradas: autorização, versão, consentimentos e responsável ativo no
   destino. `tx.now` é capturado no primeiro uso, já depois dos bloqueios.
5. Escritas: prazo e intimação mudam de escopo juntos e os eventos são gravados (`seq` define a
   ordem). As notificações são inseridas com `ON CONFLICT DO NOTHING`.
6. Preparação:
   - capacidade;
   - responsável operacional das intimações pendentes;
   - política da caixa (bloqueio consultivo por destinatário, em ordem estável).
7. `COMMIT`: o PostgreSQL verifica as FKs diferidas (mesmo ambiente, responsável e sugerido ativos).
   Uma violação ali vira `ConsistencyError`, e o rollback é integral.

## 3. Transações e ordem dos bloqueios
| Etapa | Mecanismo |
|---|---|
| Âncoras de escopo | `offices` (escritório) e `users` (escopo pessoal), `FOR NO KEY UPDATE`, travadas no ponto de acesso ou antecipadamente (`lock_anchors`, IDs ordenados) |
| Vínculos | estáveis sob a âncora do escritório; vínculo único garantido por `ON CONFLICT … WHERE office_id = excluded.office_id` → 409 `already_in_office` |
| Prazos / intimações | `FOR UPDATE` da linha, depois da âncora; escopo revalidado após o bloqueio |
| Caixas de notificação | `pg_advisory_xact_lock(hashtextextended('inbox:'‖destinatário))` na preparação, em ordem estável |
| Relógio | **um** instante por operação (`tx.now`, capturado no primeiro uso), sempre **depois** das âncoras. Proteção: adquirir uma âncora nova depois de capturar o relógio é erro de programação (`LateAnchorError`); criações travam o escopo de destino antes (`lock_anchors`) |
| Vínculo em outro escritório | consultado depois do relógio (ex.: a pessoa já está em OUTRO escritório) → lido sem travar o escritório alheio: mudar vínculo NESTE escritório exige a âncora já segura; vínculo único pela PK; ingressos da mesma pessoa serializados pela âncora pessoal |
| Código de ingresso | inserção num `SAVEPOINT`; colisão → `JoinCodeCollisionError` → novo código, sem transação abortada; tentativas limitadas → 503 |
| Conflitos | `40P01`/`55P03` → 409 `concurrent_update` (sem retry). `IntegrityError` inesperada **não** vira conflito normal |
| Leituras | `REPEATABLE READ READ ONLY`: autorização, dados, projeções e contadores no mesmo snapshot |

## 4. Regra → mecanismo → teste
| Regra | Mecanismo | Teste (PostgreSQL real) |
|---|---|---|
| Último administrador | âncora do escritório + contagem revalidada | suítes HTTP em `postgres` (`test_org_team_http`, `test_org_concurrency`) |
| Ingresso em um escritório | PK de `memberships` + upsert condicionado → 409 | `test_ingresso_concorrente_em_escritorios_diferentes` |
| Solicitação × ingresso em outro escritório | criar solicitação, aceitar convite, aprovar e criar escritório travam a âncora da PESSOA antes do relógio e revalidam o vínculo depois | `test_solicitacao_concorrendo_com_ingresso_em_outro_escritorio` (duas ordens) |
| Relógio pós-lock na criação | âncora do escopo (pessoal/escritório) antes de `tx.now` | `test_prazo_pessoal_usa_o_instante_apos_a_ancora_pessoal`, `test_intimacao_pessoal_…`, `test_criacao_de_escritorio_…` (recurso E eventos) |
| Delegação sem escalada | regras do serviço, revalidadas após a âncora | `test_perda_de_autoridade_concorrendo_com_mutacao_administrativa` + suítes HTTP |
| Remoção/saída com reatribuição atômica | uma transação; FK diferida de responsável ativo | `test_remocao_de_membro_concorrendo_com_atribuicao` (duas ordens), `test_rollback_integral_em_pontos_entre_modulos` |
| Responsável operacional das pendências | verificação na preparação | `test_escritas_invalidas_diretas_recusadas_pelo_banco` + suítes de intimações |
| Confirmação sem duplicar prazo | âncora + `FOR UPDATE` da intimação + `UNIQUE (deadline_id)` | `test_confirmacoes_simultaneas_da_mesma_intimacao` |
| Transferência conjunta com consentimentos | âncoras antecipadas + FK diferida de mesmo ambiente | `test_transferencia_concorrendo_com_edicao`, `test_falha_real_no_commit_por_fk_diferida_desfaz_tudo` |
| Eventos e notificações na mesma transação | uma conexão por operação | `test_rollback_restaura_exclusoes_da_caixa_sql`, pontos `unit:prepare`/`unit:commit` |
| Capacidade (prazos, comentários, histórico, intimações, eventos) | contagem na preparação, sob âncora | `test_escritores_concorrentes_no_limite_de_capacidade` |
| Deduplicação e caixa | `ON CONFLICT` + bloqueio consultivo + remoção ordenada (lidas → não lidas, mais antigas) | `test_deduplicacao_e_capacidade_da_caixa_com_escritores_concorrentes` |
| Colisão de código | `SAVEPOINT` | `test_colisao_de_codigo_gera_outro_sem_abortar`, `test_colisao_persistente_falha_sem_criar_nada` |
| Expiração pós-lock e no instante exato | relógio depois da âncora | `test_convite_expira_durante_a_espera_pela_ancora`, `test_convite_no_instante_exato_apos_espera`, `test_revogacao_usa_o_horario_pos_lock`, `test_teto_de_pendentes_usa_o_horario_pos_lock`, `test_carimbos_da_aprovacao_pos_lock` |
| Leituras consistentes | `REPEATABLE READ READ ONLY` | `test_listagem_coerente_quando_outra_conexao_cria_entre_consultas`, `test_notificacoes_coerentes_com_perda_de_permissao_entre_consultas`, `test_calendario_coerente_com_reatribuicao_entre_consultas` |
| Página vazia com total e contadores | consultas de contagem independentes | `test_pagina_alem_da_ultima_com_total_e_contadores` |
| Persistência | banco | `test_persistencia_apos_recriar_aplicacao_e_engine` |
| Ordem de eventos no mesmo instante | `seq` (0003) | suítes HTTP (`test_reatribuicao_por_patch`…), `test_db_p4_seq` |

**Suítes comuns:** com `PRAZOAI_TEST_STORAGE=postgres`, todas as suítes HTTP de autenticação e
de domínio rodam contra o banco. As asserções de estado usam visões somente leitura com a mesma
interface dos armazenamentos.

**Testes exclusivos de memória:** 22 casos, cada um com a justificativa no marcador
`memory_only`:
- dependem do RLock da memória, de injeção direta de estado ou de identidade de objetos, e os
  equivalentes SQL estão citados no marcador;
- 5 são de retenção (expurgo), sem equivalente nesta entrega porque o expurgo global é da P5;
- 4 são da autenticação (P3), com equivalentes em `test_auth_sql_hardening`.

## 5. Configuração e comandos seguros
| `STORAGE` | Resultado |
|---|---|
| `memory` (padrão) | tudo em memória |
| `postgres` | autenticação e domínio no PostgreSQL; aceito em `development` e `test`; exige `DATABASE_URL` e a revisão `0003` (verificação somente leitura) |
| `auth-postgres` | **removido na P4**, recusado com mensagem de migração. O modo intermediário servia só para a P3, e o domínio agora também persiste. `ALLOW_VOLATILE_DOMAIN` deixou de existir |
| `AUTH_STORAGE` junto com `postgres` | recusado (conflito) |
| `ENVIRONMENT=production` | recusado incondicionalmente |

Health em `postgres`: `{"status","service","storage":"postgres","durable":true}`. `durable`
refere-se ao **backend**; as sessões do BFF continuam em memória no processo do Next.

```bash
cd backend
export DATABASE_URL=postgresql+psycopg://prazoai:<senha>@localhost:5432/prazoai_dev   # banco DESCARTÁVEL
alembic upgrade head                      # 0003 (explícito; nunca no startup)
ENVIRONMENT=development STORAGE=postgres AUTH_JWT_SECRET=<segredo-estável> uvicorn app.main:app --no-proxy-headers
# testes
ENVIRONMENT=test TEST_DATABASE_URL=postgresql+psycopg://prazoai:<senha>@localhost:5432/prazoai_test pytest
ENVIRONMENT=test TEST_DATABASE_URL=... PRAZOAI_TEST_STORAGE=postgres pytest tests/test_deadlines_http.py
# integração/E2E contra o banco (bancos próprios, já migrados)
STORAGE=postgres DATABASE_URL=...prazoai_e2e npm run test:e2e
```

## 6. Limitações e separação P4 × P5
- **Retenção (P5):** convites e solicitações encerrados, intimações descartadas e notificações
  lidas expiradas **não são expurgados** no PostgreSQL. `uow.purge()` devolve 0. Diferença
  temporária em relação à memória, que expurga de forma oportunista dentro das transações. A caixa
  de notificações continua limitada pela política de capacidade, que é desta entrega.
- **Busca sem maiúsculas:** usa `lower()` no PostgreSQL e no Python (antes era `casefold()` na
  memória; alinhado para a mesma regra). Diferenças só em casos raros de Unicode (ex.: "ß").
- **Ordenação de títulos:** `lower(title) COLLATE "C"`, ordem por ponto de código, como no Python.
- **Paginação por offset:** ordenação determinística não impede deslocamentos entre requisições
  com inserções concorrentes. O contrato de paginação não foi redesenhado.
- **`seq`:** ordem interna por recurso, não é horário, contador sem lacunas nem ordem global de
  commits. Registros antigos com instante idêntico foram ordenados por `id` na migração (a ordem
  original não é recuperável); o downgrade perde essa informação.
- **Sessões do BFF e rate limiting:** continuam por processo.

## 8. Correções da auditoria (sobre `fc846b2`)
- **Artefatos incompletos.** *Causa:* na consolidação usei `git reset --soft` + `git commit` sem
  `git add -A`. O commit ficou com o índice de `6d4cb0f`, e o doc 19, o CI, README, `.env.example`,
  as notas dos docs 15/18 e a correção do MyPy ficaram só na árvore de trabalho. Os artefatos saem
  do commit, então não continham essas alterações. *Correção:* commit incremental com tudo; as
  validações desta entrega foram executadas com a árvore limpa, idêntica ao commit final, e cada
  artefato teve a árvore reproduzida conferida.
- **CI efetivo.**
  - As suítes HTTP de autenticação e domínio rodam com `PRAZOAI_TEST_STORAGE=postgres`, e um valor
    desconhecido (como o antigo `auth-postgres`) agora **falha** a sessão.
  - `test_storage_effective.py` exige que as apps de teste subam em `postgres` e gravem no banco.
  - O job de integração/E2E tem PostgreSQL de serviço e migrations explícitas, e confere o health
    (`storage=postgres`, `durable=true`) antes da integração.
  - A integração roda em `memory` e em `postgres`; o E2E completo, contra `postgres`; depois de
    ambos, há conferência de dados persistidos.
- **MyPy:** o nome do ponto de controle e o nome opcional da constraint usam variáveis separadas.
- **Relógio realmente pós-lock.**
  - Criação de prazo e de intimação: o escopo de destino é travado antes de `tx.now`.
  - Criação de escritório, solicitação, aceite e aprovação: a pessoa é travada antes de `tx.now`.
  - A proteção `LateAnchorError` impede regressões.
  - O relógio continua com um único instante por operação (não é atualizado a cada acesso).

## 7. Roteiro de apresentação (TCC, cerca de 5 minutos)
1. **O que mudou (30 s):** "Na P4 o PrazoAI deixa de perder escritórios, prazos, intimações e
   notificações ao reiniciar. Memória continua existindo para testes rápidos."
2. **Arquitetura (1 min):** os serviços conhecem só contratos (unidade de trabalho e consultas);
   há duas implementações, e as mesmas suítes HTTP rodam nas duas.
3. **Uma operação (1 min 15 s):** a transferência trava as âncoras em ordem, relê o que vai mudar,
   olha o relógio só depois e grava tudo numa transação. Se algo falha, nada fica pela metade.
4. **Concorrência provada (1 min):** duas confirmações da mesma intimação geram um único prazo;
   duas pessoas entrando em escritórios diferentes ao mesmo tempo resultam num só vínculo; tudo
   observado no próprio PostgreSQL, sem sleeps.
5. **Leituras honestas (45 s):** listas, totais e contadores vêm do mesmo snapshot; uma permissão
   perdida no meio da consulta não deixa números incoerentes.
6. **Limites (30 s):** expurgo global na P5, sessões do BFF em memória e produção bloqueada.
