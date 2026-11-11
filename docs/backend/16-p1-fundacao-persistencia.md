# 16 — P1: fundação da persistência PostgreSQL

> **Base:** `main` `d0e182eb0d8bc9ee14e925d97cb9db1ef2fdb9d1` (sem mudanças desde a análise),
> branch `feature/persistence-p1` criada sobre os commits de projeto `965ab64` e `ab29ed4` (histórico
> preservado). Projeto aprovado: `15-projeto-persistencia-postgresql.md`.
>
> **Escopo:** somente a fundação. A aplicação **continua usando só memória**, com comportamento
> preservado. Não há tabelas de negócio, repositórios SQL, manutenção nem integração de dados.
> Migrations nunca rodam no startup. `production` continua bloqueada. O frontend não foi alterado.

## 1. O que a P1 entrega
| Item | Onde | Como funciona |
|---|---|---|
| Dependências fixadas | `backend/requirements.txt` | `SQLAlchemy==2.1.8` (Core), `alembic==1.20.1`, `psycopg[binary]==3.3.8` (driver síncrono, alinhado aos endpoints `def`). `pip check` limpo com FastAPI 0.162 e pydantic-settings 2.16 |
| Configuração | `app/core/config.py` | `STORAGE` (só `memory`; `auth-postgres`/`postgres` recusados com mensagem explícita até a P3/P4), `DATABASE_URL` (segredo, `SecretStr`), pool e timeouts com limites; `DATABASE_STATEMENT_TIMEOUT_MS ≥ DATABASE_LOCK_TIMEOUT_MS`; `AUTH_STORAGE=memory` aceito com aviso de descontinuação |
| Validação da URL sem credenciais | `app/db/config.py` | só `postgresql`/`postgresql+psycopg`; banco obrigatório; recusa `options`, `service`, `hostaddr`, `dbname` e vários hosts; erros sem o valor recebido e sem encadear a exceção original; `safe_target()` mostra só `host:porta/banco` |
| Engine Core sob demanda | `app/db/engine.py` | `create_db_engine()` / `engine_scope()` (com `dispose()` garantido); cada conexão nasce com `lock_timeout`, `statement_timeout`, `search_path=prazoai`, `application_name` e `connect_timeout`; `hide_parameters=True` |
| Metadados | `app/db/metadata.py` | `MetaData(schema="prazoai")` com convenção de nomes; **nenhuma tabela** |
| Alembic | `backend/alembic.ini`, `backend/migrations/` | URL só de `DATABASE_URL` (nunca no `.ini`); versão em `prazoai.alembic_version`; esquema criado na mesma transação; revisão `0001` **vazia e reversível**; bloqueado em `production`; modo offline recusado |
| Verificação de conexão | `python -m app.db check` | conecta, mostra destino (sem credenciais), versão, timeouts efetivos e revisão; não altera nada; em falha mostra só a classe do erro |
| CI | `.github/workflows/ci.yml` | serviço `postgres:16` no job `backend`; pytest com `ENVIRONMENT=test`, `TEST_DATABASE_URL` e `PRAZOAI_REQUIRE_POSTGRES_TESTS=1`; ciclo das migrations pela linha de comando num banco separado; `ruff`/`compileall` incluem `migrations` |
| Fixture protegida | `tests/pg_support.py`, `tests/conftest.py` | ver §3 |

## 2. Funcionamento no modo `memory` (preservado)
- `create_app()` **não importa** `app.db`, SQLAlchemy nem psycopg. Isso é verificado em teste por
  um subprocesso que cria a aplicação com `DATABASE_URL` definida.
- Com `DATABASE_URL` definida, o startup só registra `database_url_ignored` (sem a URL), sem
  conectar nem validar o conteúdo.
- As 607 verificações anteriores do backend e as suítes do frontend continuam iguais.

## 3. Proteções do banco de teste (doc 15, §5.7)
Ordem: **autorização sem conectar** → **verificações só de leitura** → **escritas**.
1. **URL própria:** os testes usam `TEST_DATABASE_URL`, nunca `DATABASE_URL`.
2. **Destino normalizado** (`normalize_target`), comparado com o da `DATABASE_URL`:
   - `localhost`, `127.0.0.1`, `::1` e sockets locais equivalem a "local";
   - porta padrão 5432;
   - `host`/`port` da query string têm precedência, como no driver.

   Mesmo destino → recusa, ainda que usuário, senha ou forma de escrever sejam outros. Uma
   `DATABASE_URL` inválida também → recusa (não dá para provar que é outro banco).
3. **Nome do banco:** `^prazoai_test(_[a-z0-9_]+)?$`.
4. **Host:** local. O serviço do CI (`postgres`) só é aceito com `CI=true`.
5. **Ambiente:** `ENVIRONMENT=test`.
6. **Somente leitura antes de escrever:** `current_database()` precisa ser o esperado. Num banco
   **sem** o marcador `prazoai.prazoai_test_marker`:
   - se houver qualquer tabela → recusa;
   - se estiver vazio → cria o marcador.

   Num banco marcado, tabelas fora do esquema `prazoai` → recusa.
7. **Limpeza:** `TRUNCATE TABLE "prazoai"."<t>", … RESTRICT`, só com as tabelas de
   `app/db/metadata.py` e nomes qualificados; **nunca** `CASCADE`, `DROP DATABASE` ou
   `DROP SCHEMA`. Na P1, não há tabelas a limpar.
8. **Sem `TEST_DATABASE_URL`:** localmente os testes `postgres` são **pulados** (aparecem como
   `SKIPPED`); com `PRAZOAI_REQUIRE_POSTGRES_TESTS=1` (CI), **falham**.
9. **Esquema explícito:** `search_path=prazoai` em cada conexão, e o código qualifica
   `"prazoai".<tabela>`; nada depende de um `search_path` arbitrário.

## 4. Comandos
```bash
cd backend
python -m venv .venv && . .venv/bin/activate
pip install -r requirements-dev.txt

# banco local de desenvolvimento (exemplo; qualquer PostgreSQL 16)
createdb prazoai_dev
export DATABASE_URL=postgresql+psycopg://prazoai:<senha>@localhost:5432/prazoai_dev
python -m app.db check                       # destino, versão, timeouts, revisão
alembic upgrade head                         # revisão 0001 (vazia)
alembic current                              # 0001 (head)
alembic downgrade base                       # reverte

# testes (o banco de teste é OUTRO, descartável)
createdb prazoai_test
ENVIRONMENT=test TEST_DATABASE_URL=postgresql+psycopg://prazoai:<senha>@localhost:5432/prazoai_test pytest
ruff check app tests migrations && mypy app && python -m compileall app migrations
```

## 5. Mapa dos arquivos
```
backend/
├─ requirements.txt                 # + SQLAlchemy, alembic, psycopg[binary] (versões fixas)
├─ .env.example                     # + STORAGE, DATABASE_* e TEST_DATABASE_URL (comentados)
├─ alembic.ini                      # Alembic sem URL; log no console
├─ migrations/
│  ├─ env.py                        # URL de DATABASE_URL; esquema prazoai; bloqueio em production
│  ├─ script.py.mako                # modelo de novas revisões
│  └─ versions/0001_fundacao.py     # revisão inicial VAZIA e reversível
├─ app/core/config.py               # STORAGE, DATABASE_*, timeouts; AUTH_STORAGE compatível
├─ app/main.py                      # aviso "DATABASE_URL ignorada" (sem conectar)
├─ app/db/
│  ├─ __init__.py                   # pacote NÃO usado pela aplicação nesta entrega
│  ├─ config.py                     # validação da URL, destino seguro, DatabaseConfig, SCHEMA
│  ├─ engine.py                     # engine sob demanda + engine_scope (dispose)
│  ├─ metadata.py                   # MetaData(schema="prazoai"), sem tabelas
│  └─ __main__.py                   # python -m app.db check
└─ tests/
   ├─ pg_support.py                 # autorização, normalização, verificação, TRUNCATE seguro
   ├─ conftest.py                   # fixtures pg_url, pg_config, pg_engine, pg_clean (+ marcador postgres)
   ├─ test_db_foundation.py         # sem banco: configuração, URL, fixture, engine, Alembic, production
   └─ test_db_postgres.py           # com PostgreSQL real: conexão, timeouts, dispose, migrations, recusas
.github/workflows/ci.yml            # serviço postgres:16 + ciclo das migrations
docs/backend/15-…, 16-…             # projeto (revisão 3) e esta P1
```

## 6. Resultados
Os resultados executados estão no relatório da entrega. O que fica **planejado** para as próximas
entregas (não implementado na P1): tabelas e testes de restrição (P2); autenticação no PostgreSQL,
com teto de rotações, concorrência com reset e relógio pós-lock (P3); domínio, leituras em
`REPEATABLE READ`, total de páginas vazias e concorrência (P4); manutenção (P5).

## 7. Para a apresentação (Lucas, cerca de 1 minuto)
"Na P1 preparamos o terreno do banco sem mexer no funcionamento:
- **conexão:** SQLAlchemy Core e psycopg 3, com timeouts e esquema explícito;
- **migrations:** Alembic com uma revisão inicial vazia, que aplica e reverte sem tabelas;
- **testes:** PostgreSQL 16 real no CI, com uma fixture que só aceita um banco descartável de
  teste e recusa qualquer outro antes de escrever.

A aplicação continua em memória, ignora a `DATABASE_URL` e não se conecta ao banco. Produção
continua bloqueada. As tabelas de verdade chegam na P2."
