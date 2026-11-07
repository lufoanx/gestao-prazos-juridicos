# PrazoAI — Backend (fundação, sem banco de dados)

Fundação da API do PrazoAI em **FastAPI (Python)**. Esta etapa é apenas a base
testável: **não há banco de dados, ORM, autenticação real nem integração com o
frontend**. Expõe oficialmente `GET /api/v1/health`, mantendo `GET /api/health`
apenas como alias legado, além dos demais endpoints legados preservados.

> **Stack oficial: Python/FastAPI.** Decisão do projeto é preservar o backend
> Python existente; não há migração para NestJS. Ver
> `docs/backend/02-arquitetura-proposta.md`.

## Requisitos
- Python 3.11+ (desenvolvido em 3.12)

## Instalação (ambiente isolado, reproduzível)
```bash
cd backend
make install        # cria .venv e instala requirements-dev.txt
```
Sem Makefile:
```bash
cd backend
python3 -m venv .venv
.venv/bin/pip install -U pip
.venv/bin/pip install -r requirements-dev.txt
```

## Execução
```bash
make dev            # uvicorn app.main:app --reload --port 8000
# ou
.venv/bin/uvicorn app.main:app --reload --port 8000
```

## Windows (PowerShell)
Equivalentes dos comandos acima, executados a partir da pasta `backend`:
```powershell
# criação e ativação do venv
py -3 -m venv .venv
.\.venv\Scripts\Activate.ps1
# (se a execução de scripts estiver bloqueada, rode uma vez:)
# Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass

# instalação
python -m pip install --upgrade pip
pip install -r requirements-dev.txt

# execução
uvicorn app.main:app --reload --port 8000

# verificações
pytest
ruff check app tests
mypy app
python -m compileall app
```
No Windows, use os comandos acima diretamente (o `make` normalmente não está disponível).

## Verificações (equivalentes a test/lint/typecheck/build)
> Backend em Python não usa `package.json`/`npm`. Os alvos abaixo são os
> equivalentes reais e são executáveis.
```bash
make test        # pytest
make lint        # ruff check app tests
make typecheck   # mypy app
make build       # python -m compileall app (valida compilação; sem artefato)
```

## Endpoint de saúde (versionado)
Contrato canônico:
```
GET /api/v1/health  ->  200
{ "status": "ok", "service": "prazoai-backend" }
```
Alias **legado** de compatibilidade (mesmo corpo): `GET /api/health` — o contrato
oficial é `/api/v1/health`.

## Endpoint legado `/calcular-prazo` — validação (Issue #3)
```
GET /calcular-prazo?data_inicial=01/12/2026&dias=5  ->  200
{ "data_inicial": "01/12/2026", "dias": 5, "data_final": "08/12/2026" }
```
- `data_inicial` deve estar em `DD/MM/AAAA` e ser uma data existente (ex.: `31/02/2026` é rejeitada).
- `dias` deve ser inteiro `>= 1`. Não há limite máximo arbitrário; só é rejeitado
  o valor cujo resultado ultrapassaria o calendário suportado (31/12/9999).
- Entradas inválidas retornam **422** no formato padronizado, sem detalhes internos:
  `{"error": {"code": "validation_error", "message": "Dados inválidos.", "details": [{"field": "query.dias", "message": "..."}]}}`.
- A mesma regra existe no serviço (`EntradaPrazoInvalidaError` em `app/services/prazo_service.py`).

## Configuração (variáveis de ambiente)
Copie `.env.example` para `.env` (nenhum segredo necessário nesta etapa):
- `SERVICE_NAME` (padrão `prazoai-backend`)
- `ENVIRONMENT` (`development` habilita Swagger em `/docs`; `production` desabilita)
- `API_PREFIX` (padrão `/api`)
- `API_VERSION_PREFIX` (padrão `/v1`; base canônica = `API_PREFIX`+`API_VERSION_PREFIX` → `/api/v1`)
- `ENABLE_LEGACY_HEALTH_ALIAS` (padrão `true`; expõe `/api/health` como alias legado)
- `CORS_ORIGINS` (lista separada por vírgula; padrão `http://localhost:3000`). Em produção, liste origens explícitas; `"*"` é **descartado** porque `allow_credentials=True`.
- `LOG_LEVEL` (padrão `INFO`)

## Observações
- **Sem banco/ORM**: nenhuma dependência de persistência foi instalada.
- **Sem segredos** no repositório; `.env` é ignorado pelo `.gitignore`.
- Endpoints legados `/` e `/calcular-prazo` foram **preservados** (o cálculo
  legado é demonstrativo, não é cálculo processual oficial).
- Swagger/OpenAPI em `/docs` e `/openapi.json` apenas fora de produção.
