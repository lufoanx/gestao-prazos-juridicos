# 31 — Qualidade de código (SonarQube Cloud)

O repositório é analisado pelo **SonarQube Cloud** (plano gratuito para projetos públicos, análise automática a
cada push no `main` e em cada pull request). A primeira análise (commit `69d415e`) apontou **68 issues**:
Segurança **E**, Confiabilidade **D**, Manutenibilidade **A**. Todas foram corrigidas no código; nenhuma foi
"aceita" ou escondida no painel.

## 1. Segurança

| Regra | Onde | O que era | Correção |
| --- | --- | --- | --- |
| S6698 (21, Blocker) e S2068 (6) | `.github/workflows/ci.yml` | senha do PostgreSQL **de teste** escrita nas URLs e no YAML | a senha não fica mais no repositório: é gerada por execução do CI (`ci-<run_id>-<tentativa>`) e chega aos clientes só por `PGPASSWORD`, que libpq/psycopg e node-postgres leem quando a URL não tem senha |
| S7631 (High) | `publicar-imagens.yml` | gatilho `workflow_run` + checkout do commit de outra execução | o workflow virou reutilizável (`workflow_call`) e é chamado pelo último job do CI, só em push no `main` e depois de todos os testes; o checkout é o do próprio commit |
| S7637 (High) | `publicar-imagens.yml` | action de terceiros (`docker/login-action@v3`) presa só por tag | removida: login no GHCR com `docker login --password-stdin` e o token temporário da execução |
| S6470 (High) | `frontend/Dockerfile` | `COPY . .` (copiava a pasta inteira para a imagem) | cópia explícita só do que o build usa (`src`, `public`, `scripts` e os arquivos de configuração) |
| S6505 (5) | CI e `frontend/Dockerfile` | `npm ci` / `npm install` executavam scripts de instalação de pacotes | `--ignore-scripts` (nenhum pacote do projeto precisa deles; build e testes conferidos) |
| S8541 e S8544 (7) | CI e `backend/Dockerfile` | `pip install` sem travar versões verificadas e aceitando pacotes-fonte | `requirements.lock` e `requirements-dev.lock` com **hash SHA-256** de cada arquivo; instalação com `--only-binary :all: --require-hashes` |
| S5332 (Low) | `frontend/e2e/global-setup.mjs` | URL base `http://x` | `http://localhost` (servidor de teste local) |

## 2. Confiabilidade e manutenibilidade

| Regra | Onde | Correção |
| --- | --- | --- |
| S8786 (regex lenta) | `backend/app/files/pdf.py` | busca de `N G obj` com limites e âncora — tempo linear mesmo com arquivo malicioso |
| S8786 (regex lenta) | 5 telas de login/cadastro/recuperação | uma só regra de formato de e-mail em `frontend/src/lib/email-format.ts`, sem ambiguidade no domínio |
| S2871 (sort sem comparação) | `deadlines-view.mjs`, `tests/helpers/sensitive.mjs` | `localeCompare` (ordem alfabética correta com acentos, em pt-BR) |
| S9383 (promessa solta) | `auth-controller.mjs` e telas do escritório | `void` explícito; cópia para a área de transferência em `frontend/src/lib/clipboard.ts`, que trata a falha |
| S7727 | `data-sanitize.mjs` | função explícita no `filter` |
| S7773 | formulário de prazo e configurações | `Number.parseInt` |
| S6848, S6852 (acessibilidade) | `Modal.tsx`, `Navigation.tsx` | fundo do modal com `role="presentation"`; teclas das abas tratadas em cada aba (focável), não na lista |
| S3403 | `tests/helpers/fake-backend.mjs` | tipo declarado do campo de falha simulada |
| S2699 (teste sem asserção) | 3 testes do frontend | `assert.ok` explícito |

## 3. Como foi verificado

- Backend: suíte completa contra PostgreSQL real com a senha só por `PGPASSWORD` (inclui banco com TLS),
  suíte HTTP com `STORAGE=postgres`, migrations ida e volta, `ruff` e `mypy`.
- Frontend: instalação limpa com `--ignore-scripts`, testes unitários (com e sem PostgreSQL), `typecheck`,
  `lint`, build demo e integrado, integração BFF + FastAPI (memória e PostgreSQL) e E2E no navegador.
- Workflows: `actionlint` sem erros.
- Depois do merge, o SonarQube Cloud reanalisa o `main` sozinho.

## 4. Manutenção

Mudou `backend/requirements.txt` ou `requirements-dev.txt`? Rode `make lock` em `backend/` (precisa do `uv`)
e faça commit dos dois `.lock` — o CI e o Docker instalam **só** a partir deles.
