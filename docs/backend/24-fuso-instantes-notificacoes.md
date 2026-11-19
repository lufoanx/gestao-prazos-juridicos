# 24 — Fuso das notificações: instantes do PostgreSQL sempre em UTC

> **Tipo de entrega:** correção isolada do backend (camada de tabelas SQL), mais testes e
> documentação. Não inclui funcionalidade nova, migration, reescrita de dados, mudança no frontend,
> no CI ou nas dependências. O deslocamento de layout no convite (doc 21 §17.2) continua separado.
>
> **Base:** `main` `75f3b664a6afea07c45e5caa88b56fc9b12400cf` (merge do PR #29; árvore
> `fe40b61bf9c34217638f8b7027d2ea63125dc29c`; CI `44226775733` verde nos quatro jobs). Branch
> `fix/fuso-notificacoes`.

## 1. Sintoma
`test_notifications::test_marcar_lida_individual_e_de_terceiros` falhava sempre que o PostgreSQL
usava um `TimeZone` diferente de UTC (registro em doc 21 §16.4). O CI usa UTC, por isso nunca falhou lá.

```
assert again.json()["readAt"] == r.json()["readAt"]               # idempotente
AssertionError: assert '2026-11-09T09:00:01-03:00' == '2026-11-09T12:00:01Z'
```

## 2. Instante ou representação?
**Só a representação estava errada; o instante estava certo.** `09:00:01-03:00` e `12:00:01Z` são o
mesmo instante. Na reprodução (§3), a consulta ao banco confirmou que o valor gravado era
exatamente o instante do relógio injetado. Uma comparação `read_at = :instante_utc` encontra a linha
em qualquer fuso de sessão.

| Fuso da sessão | O que o banco guarda | Como o driver devolve | O que a API serializava (base) |
|---|---|---|---|
| UTC | `2026-11-10 02:30:00.123456+00` | `datetime(…02:30:00.123456, tzinfo=UTC)` | `2026-11-10T02:30:00.123456Z` |
| America/Sao_Paulo | o mesmo instante | `datetime(2026-11-09 23:30:00.123456, tzinfo=UTC−03:00)` | `2026-11-09T23:30:00.123456-03:00` |
| Pacific/Kiritimati | o mesmo instante | `datetime(2026-11-10 16:30:00.123456, tzinfo=UTC+14:00)` | `2026-11-10T16:30:00.123456+14:00` |

## 3. Reprodução na base (executada)
O cluster descartável local usa `TimeZone=UTC`. O fuso foi aplicado **só a bancos de teste
descartáveis** (`prazoai_test_*`), no nível do banco (`ALTER DATABASE … SET timezone`). Cada banco foi
apagado ao final. O servidor e os bancos existentes não foram alterados.

| Execução na base `75f3b66` | UTC | America/Sao_Paulo |
|---|---|---|
| `tests/test_notifications.py` (postgres) | 9 passed, 1 skipped | **1 failed**, 8 passed, 1 skipped |
| Suíte completa (como o job `backend`) | — | 1014 passed, 1 skipped |
| Suítes HTTP em `STORAGE=postgres` | — | **1 failed** (o mesmo teste), 460 passed, 24 skipped |

O controle em UTC das suítes completas na base é o CI oficial `44226775733` (verde) e a validação
final local (§8), executada no cluster em UTC. Uma execução de controle local na base em UTC foi
interrompida por mim, pois reutilizei o nome do banco numa sonda paralela, e foi descartada, sem que
o resultado fosse usado.

Uma **sonda temporária**, que não foi versionada, comparou as respostas de escrita e de leitura da API em
`STORAGE=postgres` com o banco em America/Sao_Paulo:

| Resposta | Sufixo dos instantes (base) |
|---|---|
| `POST /deadlines`, `POST /intimations` (instantes vindos do relógio) | `Z` |
| `GET /users/me`, `/auth/me`, `/deadlines/{id}`, `/deadlines/{id}/history`, `/intimations/{id}`, `/intimations/{id}/history`, `/offices/{id}`, `/offices/{id}/members`, `/offices/{id}/invitations`, `/notifications` | `-03:00` |
| Os mesmos `GET` em `STORAGE=memory` | `Z` |

Portanto, a inconsistência **não era exclusiva das notificações**: todo instante lido do banco seguia
o fuso da sessão. Só as notificações tinham um teste que comparava duas respostas (a primeira
marcação usa `tx.now`; a repetição relê o banco).

## 4. Causa
- O contrato da API (`_Output`, Pydantic) serializa um `datetime` com o fuso que ele carrega:
  `timezone.utc` vira `Z`, e um deslocamento fixo vira `±hh:mm`.
- O domínio trabalha com instantes em UTC. O relógio (`app/core/clock.py`) devolve
  `datetime.now(timezone.utc)`, e o modo memória guarda esses objetos sem conversão.
- As colunas de instante são `timestamptz` (`instant()` em `app/db/tables/_types.py`, usado por todas
  as tabelas). O psycopg 3 converte `timestamptz` para `datetime` com o fuso **da sessão**.
- O mapeamento SQL→domínio (`app/repositories/sql/domain/mapping.py`) e o repositório de autenticação
  repassavam esse valor sem normalizar. Nenhuma camada convertia para UTC; a busca por `astimezone` e
  `tzinfo` em `repositories`, `db`, `schemas` e `api` não encontrou nada.

## 5. Fronteira corrigida e alternativas
A correção fica no **conversor compartilhado de leitura**, onde a diferença nasce:

```python
class UtcInstant(TypeDecorator[datetime]):
    impl = DateTime(timezone=True)
    cache_ok = True

    def process_result_value(self, value, dialect):
        if value is None:
            return None
        if value.tzinfo is None or value.utcoffset() is None:
            raise ValueError("timestamptz lido sem fuso: instante ambíguo")
        return value.astimezone(timezone.utc)


def instant(name, *, nullable=False):
    return Column(name, UtcInstant(), nullable=nullable)
```

- `astimezone(timezone.utc)` **converte**: preserva o instante e os microssegundos. Não há
  `replace(tzinfo=UTC)`, que trocaria o instante de um valor que já tem outro fuso.
- `None` continua `None`. Um valor sem fuso, que um `timestamptz` não produz, é **recusado** em vez de
  "adivinhado".
- A escrita (`process_bind_param`) não muda. O tipo no banco continua `timestamptz`, e o DDL, as
  migrations e os dados existentes também não mudam. O teste de esquema
  (`test_db_schema`, `compare_metadata` com `compare_type`) continua sem diferenças.

**Consumidores examinados.** `instant()` é usado em `identity` (usuários, sessões, tokens de
redefinição), `org` (escritório, vínculos, convites, pedidos de entrada), `deadlines` (prazo,
comentários, histórico), `intimations` (intimação, eventos) e `notifications`. Todas as leituras
passam pelas colunas tipadas do SQLAlchemy Core. Não há `text()` nem `func.max/min` sobre instantes;
os agregados existentes são `func.count()`. Assim, todos recebem a mesma normalização. As comparações
de expiração e retenção (`expires_at < now` etc.) já eram entre valores com fuso e não mudam de
resultado. Os testes do §6.3 cobrem as saídas afetadas da API.

**Alternativas descartadas:**
- *Normalizar só em `notification_out`:* corrigiria o teste, mas deixaria todos os outros `GET` do §3
  com `-03:00`, ou seja, a mesma inconsistência fora das notificações.
- *`SET TIME ZONE 'UTC'` na conexão (evento do pool ou `options=-c TimeZone=UTC` na URL):* mudaria só a
  apresentação da sessão. Dependeria de toda conexão, inclusive as da manutenção e do despachante de
  e-mail, passar pela configuração, e não protegeria um valor vindo de outra sessão. **Não foi usada.**
- *Configurar o servidor PostgreSQL em UTC:* pedido explicitamente como fora de escopo. A correção
  não depende disso, como prova o §6.

**Escrita sem fuso (verificada, não alterada).** Um `datetime` sem fuso gravado num `timestamptz`
seria interpretado no fuso da sessão e **mudaria o instante**. Uma sonda temporária, não versionada,
recusava gravações sem fuso. Ela rodou a suíte completa (1015 passed, 1 skipped) e as suítes HTTP em
postgres (461 passed, 24 skipped) com o banco em America/Sao_Paulo e **não houve nenhuma** gravação sem
fuso. Todas as gravações vêm do relógio UTC. Por isso a escrita ficou como estava (§9).

## 6. Instante × data civil
- **Instantes** (`createdAt`, `updatedAt`, `readAt`, `closedAt`, `expiresAt`, `joinedAt`, `decidedAt`,
  `at`): sempre UTC com `Z`, com o mesmo valor e a mesma precisão em qualquer fuso da sessão.
- **Datas civis e horários sem fuso** (`dueDate`, `startDate`, `agenda_time`, contagem de prazos,
  feriados, calendário): são `date` e `time` no banco e não passam pelo conversor. Nenhuma regra de
  urgência, de calendário ou do relógio após o lock foi tocada.
- A data de um instante depende do fuso de quem olha. Os testes usam instantes em que o dia muda:
  `2026-11-09T23:59:59.999999Z` já é dia 10 em Kiritimati, e `2026-11-10T02:30:00.123456Z` ainda é
  dia 9 em São Paulo. A API devolve sempre o instante em UTC. A exibição local é responsabilidade do
  frontend, que não foi alterado.

## 7. Testes de regressão (`backend/tests/test_notifications_timezone.py`)
O fuso é aplicado com `ALTER DATABASE <banco de teste> SET timezone = …`, apenas no banco já
autorizado por `tests/pg_support.py` (nome `prazoai_test*` e marcador de teste). Ao final, a fixture
restaura a configuração anterior e confere a restauração. O pool é descartado antes e depois para que
nenhuma conexão leve o fuso a outro teste. Os fusos são literais fixos e nunca vêm de entrada externa.

| Teste | O que prova |
|---|---|
| `test_conversor_preserva_instante_microssegundos_e_nulos` | conversão com fuso de São Paulo e de Kiritimati (instante e microssegundos), `None` |
| `test_conversor_recusa_valor_sem_fuso_em_vez_de_adivinhar` | valor sem fuso → `ValueError` (sem `replace`) |
| `test_toda_coluna_de_instante_usa_o_conversor` | toda coluna de data e hora do `MetaData` usa `UtcInstant` (e continua `timestamptz`) |
| `test_notificacoes_em_utc_em_qualquer_fuso_da_sessao[UTC / America/Sao_Paulo / Pacific/Kiritimati]` | o pool da app está no fuso (`SHOW TimeZone` antes e depois do cenário); a lista mostra `createdAt` em UTC com microssegundos e `readAt` nulo; a data civil `dueDate` fica intacta; marcar notificação de terceiro → 404; marcar a própria → `readAt` = instante do relógio em `Z`; repetir mais tarde → resposta idêntica; marcar todas: só as do próprio usuário (`marked` 1 e 2, depois 0); as não lidas zeram; `readAt` individual preservado; isolamento entre usuários; no banco, o instante gravado é exato (comparação por instante e leitura tipada em UTC), enquanto a exibição `::text` da sessão está no fuso (prova de que o cenário estava ativo, com a mudança de dia); **o transcrito é idêntico ao do modo memória** |
| `test_demais_instantes_lidos_do_banco_tambem_saem_em_utc[3 fusos]` | `/users/me`, `/auth/me`, prazo e histórico, intimação e histórico, escritório, membros, convites e `/memberships/me` só têm `Z`; os valores relidos são iguais aos devolvidos na escrita; datas civis intactas |

**Antes × depois (executado, banco de teste descartável):**

| Árvore | Resultado |
|---|---|
| Base `75f3b66` + só o novo arquivo de teste | **7 failed**, 2 passed. Falham os três testes do conversor (`ImportError`) e os quatro cenários em São Paulo e Kiritimati: `'…-03:00'`/`'…+14:00'` ≠ `'…Z'`, `{'-03:00'} == {'Z'}`, `{'+14:00'} == {'Z'}`. Os cenários em UTC passam, e por isso o CI não via o problema. |
| Com a correção | **9 passed** |

Nos dois casos, depois da execução, `SHOW timezone` no banco de teste voltou a `UTC` e
`pg_db_role_setting` ficou vazio. Nenhuma expectativa foi afrouxada. O teste original
`test_marcar_lida_individual_e_de_terceiros` não foi modificado e passa com o banco em São Paulo.

Os testes com PostgreSQL são marcados `postgres`. No CI, rodam no job `backend` (suíte completa) e
também nas suítes HTTP (glob `test_notification*.py`), sempre com o banco descartável `prazoai_test`
do serviço. O `ALTER DATABASE` exige ser dono do banco; no CI e no cluster local, o papel `prazoai` é
o dono.

## 8. Validação
Os resultados abaixo são **locais**, na árvore final limpa (commit da entrega), com PostgreSQL 16 e
Mailpit locais descartáveis em UTC. **Não são confirmação do CI.** Os resultados do CI são os do
GitHub Actions depois do push, que não foi feito.

Árvore validada: commit `60dda48` (árvore `0e26f42f144a3c32d9fe76da9053580f8e93cb8f`), `git status`
limpo antes e depois. O commit final da entrega só acrescenta esta seção §8 a este documento (§10).

| Verificação | Resultado (executado) |
|---|---|
| Testes focados de fuso + `test_notifications.py` (postgres real, 3 fusos) | 19 passed; com `PRAZOAI_TEST_STORAGE=postgres`: 18 passed, 1 skipped (`memory_only`) |
| Banco de teste após os focados | `SHOW timezone` = `UTC`; `pg_db_role_setting` vazio |
| `pip check` | No broken requirements found |
| Suíte completa do backend (PostgreSQL e Mailpit obrigatórios) | 1023 passed, 1 skipped (1014 da base + 9 novos) |
| Suítes HTTP em `STORAGE=postgres` | 470 passed, 24 skipped |
| Ciclo de migrations e manutenção (como o CI) | ok; códigos 0/4/3 |
| Ruff · MyPy (`--no-incremental`, sem cache) · `compileall` | sem problemas · sem problemas em 110 arquivos · ok |
| Frontend: `npm test` · `typecheck` · `lint` · build demo | 299/299 · ok · sem avisos · ok |
| Integração em memória (CI-like) | 45/45 |
| Integração em postgres (CI-like) | 45/45; dados persistidos; capturador vazio ao final |
| E2E completo (build integrado, Chromium local, `workers: 1`, `retries: 0`, execução única) | 59 passed (4,0 min); 0 segredos no log; `test-results` vazio |

O cluster local está em UTC, como o do CI. Os cenários fora de UTC são cobertos pelos testes do §7,
que aplicam o fuso ao banco de teste. O E2E usa o Chromium instalado localmente, porque a imagem
oficial do Playwright não é acessível neste ambiente; o navegador oficial do CI não foi substituído
no código nem na configuração.

## 10. Artefatos e base
- Base: `75f3b66` (árvore `fe40b61b`). Commits: `421a4fd` (correção + testes), `60dda48` (docs) e o
  commit que acrescenta esta seção de validação.
- ZIP limpo (`git archive`), diff e patch sobre a base. Os três reproduzem a mesma árvore do commit
  final, sem segredos, dependências, builds ou caches.
- **Sem push, PR, merge ou implantação.**

## 9. Limitações
- A escrita continua aceitando o que recebe. Hoje todas as gravações vêm do relógio UTC (§5), mas um
  `datetime` sem fuso, se surgisse no futuro, seria interpretado no fuso da sessão. Uma proteção na
  escrita seria uma melhoria separada.
- Os detalhes JSON do histórico (`details`) guardam texto ISO gerado no domínio, que já está em UTC.
  Não há dado antigo a corrigir: o banco guarda instantes, não representações. **Não houve
  migration nem reescrita de dados.**
- Bancos que já tenham `TimeZone` diferente de UTC passam a responder em UTC sem nenhuma ação.
- A exibição no fuso do usuário continua sendo do frontend, que não foi alterado.
